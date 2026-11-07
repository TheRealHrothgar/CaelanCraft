// Caelancraft — Rune Blocks: the per-cell script store and the script runner. See src/CONTRACTS.md §27. Pure.
//
// A Rune Block is an ordinary solid cell (BLOCK.RUNE_BLOCK) whose script and trigger settings live here, in a
// world-level map keyed "q,y,r" — like edits, they survive chunk unloads and are saved as an optional `runes`
// field. A rune block with no entry behaves as the default Rune (empty script, interact on).
//
// Triggers (all exposed in the editor): interact (R), step-on (edge-triggered on the set of cells supporting the
// player, with a per-rune cooldown), repeat (period while the chunk is loaded) and chain (when a script FINISHES,
// the rune blocks across all 8 faces are triggered after CHAIN_DELAY_S). Every root activation gets a wave id and a
// rune runs at most once per wave, so chains through loops always terminate; a hop cap and a running-script cap
// are backstops. Runner state is ephemeral: nothing about running scripts, timers or cooldowns is ever saved.
import {
  MAX_RUNES, MAX_RUNE_SCRIPT_CHARS, MAX_RUNE_SCRIPT_LINES, MAX_RUNE_LABEL_CHARS, REPEAT_MIN_S, REPEAT_MAX_S,
  STEP_COOLDOWN_MAX_S, MAX_RUNNING_SCRIPTS, MAX_CHAIN_HOPS, CHAIN_DELAY_S, MAX_COMMANDS_PER_FRAME, MAX_CELLS_PER_FRAME,
} from './config.js';
import { chunkKey, localIndex, worldToChunk, worldToLocal, inHeightRange } from './coords.js';
import { faceNeighbor, FACE_COUNT } from './hex.js';
import { BLOCK } from './blocks.js';
import { parseScript, executeCommand } from './commands.js';
import { supportingCells } from './physics.js';

/** @typedef {import('./types.js').Rune} Rune */
/** @typedef {import('./types.js').RunesJSON} RunesJSON */
/** @typedef {import('./commands.js').CommandContext} CommandContext */
/** @typedef {import('./commands.js').ParsedCommand} ParsedCommand */
/** @typedef {import('./commands.js').AreaJob} AreaJob */

/** Default field values; a rune equal to these is "pristine" and is not exported. */
export const RUNE_DEFAULTS = Object.freeze({
  script: '',
  label: '',
  enabled: true,
  interact: true,
  stepOn: false,
  stepCooldown: 1,
  repeat: false,
  repeatInterval: 5,
  chain: false,
});
/** Field order in RunesJSON entries. */
const RUNE_FIELDS = Object.freeze(['script', 'label', 'enabled', 'interact', 'stepOn', 'stepCooldown', 'repeat', 'repeatInterval', 'chain']);

const RUNE_KEY_RE = /^(-?\d+),(-?\d+),(-?\d+)$/;

/** Trigger sources. */
export const SOURCE = Object.freeze({ INTERACT: 'interact', STEP: 'step', REPEAT: 'repeat', CHAIN: 'chain', RUN: 'run', CONSOLE: 'console' });

/** Errors logged per script run before the rest are suppressed. */
const MAX_LOGGED_ERRORS = 3;

// ---------------------------------------------------------------------------------------------------
// Keys and normalisation
// ---------------------------------------------------------------------------------------------------

/** @returns {string} `${q},${y},${r}` */
export function runeKey(q, y, r) {
  return `${q},${y},${r}`;
}

/**
 * Strict inverse of runeKey; anything else (y out of range, or a coordinate that is not a safe integer — a 22-digit
 * q would re-stringify as "1e+21" and never round-trip) → null.
 * @returns {[number, number, number]|null}
 */
export function parseRuneKey(key) {
  const m = RUNE_KEY_RE.exec(String(key));
  if (!m) return null;
  const q = Number(m[1]);
  const y = Number(m[2]);
  const r = Number(m[3]);
  if (!inHeightRange(y) || !Number.isSafeInteger(q) || !Number.isSafeInteger(r)) return null;
  return [q + 0, y, r + 0];
}

function clampNumber(v, lo, hi, dflt) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt;
  return v < lo ? lo : v > hi ? hi : v;
}

/** Script text clamped to the char and line limits. */
export function clampScript(text) {
  if (typeof text !== 'string') return '';
  let s = text.length > MAX_RUNE_SCRIPT_CHARS ? text.slice(0, MAX_RUNE_SCRIPT_CHARS) : text;
  const lines = s.split('\n');
  if (lines.length > MAX_RUNE_SCRIPT_LINES) s = lines.slice(0, MAX_RUNE_SCRIPT_LINES).join('\n');
  return s;
}

/**
 * Build a complete, clamped Rune for cell (q, y, r) from a partial record (unknown fields ignored, missing fields
 * defaulted, booleans coerced, numbers clamped, non-finite numbers defaulted).
 * @param {number} q @param {number} y @param {number} r @param {Partial<Rune>|null|undefined} partial
 * @returns {Rune}
 */
export function normalizeRune(q, y, r, partial) {
  const p = partial && typeof partial === 'object' ? partial : {};
  return {
    q, y, r,
    key: runeKey(q, y, r),
    script: clampScript(p.script),
    label: typeof p.label === 'string' ? p.label.slice(0, MAX_RUNE_LABEL_CHARS) : '',
    enabled: p.enabled === undefined ? RUNE_DEFAULTS.enabled : Boolean(p.enabled),
    interact: p.interact === undefined ? RUNE_DEFAULTS.interact : Boolean(p.interact),
    stepOn: p.stepOn === undefined ? RUNE_DEFAULTS.stepOn : Boolean(p.stepOn),
    stepCooldown: clampNumber(p.stepCooldown, 0, STEP_COOLDOWN_MAX_S, RUNE_DEFAULTS.stepCooldown),
    repeat: p.repeat === undefined ? RUNE_DEFAULTS.repeat : Boolean(p.repeat),
    repeatInterval: clampNumber(p.repeatInterval, REPEAT_MIN_S, REPEAT_MAX_S, RUNE_DEFAULTS.repeatInterval),
    chain: p.chain === undefined ? RUNE_DEFAULTS.chain : Boolean(p.chain),
  };
}

/** @returns {Partial<Rune>} only the fields that differ from RUNE_DEFAULTS, in RUNE_FIELDS order */
export function runeToJSON(rune) {
  /** @type {Partial<Rune>} */
  const out = {};
  for (const f of RUNE_FIELDS) {
    if (rune[f] !== RUNE_DEFAULTS[f]) out[f] = rune[f];
  }
  return out;
}

/** @returns {boolean} the rune has no script and default settings */
export function isDefaultRune(rune) {
  for (const f of RUNE_FIELDS) if (rune[f] !== RUNE_DEFAULTS[f]) return false;
  return true;
}

/** Numeric total order over rune keys: q, then y, then r. */
function compareKeys(a, b) {
  const ka = parseRuneKey(a);
  const kb = parseRuneKey(b);
  if (!ka || !kb) return a < b ? -1 : a > b ? 1 : 0;
  return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
}

/**
 * Canonicalise raw RunesJSON: keys parsed strictly and rewritten canonically (`01,2,3` → `1,2,3`, last write wins),
 * values normalised and reduced to non-default fields, pristine entries dropped, at most MAX_RUNES kept (in key order).
 * @param {unknown} raw
 * @returns {{ runes: RunesJSON, warnings: string[] }}
 */
export function normalizeRunesJSON(raw) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {Map<string, Partial<Rune>>} */
  const byKey = new Map();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) warnings.push('runes: not an object, ignored');
    return { runes: {}, warnings };
  }
  for (const rawKey of Object.keys(raw)) {
    const cell = parseRuneKey(rawKey);
    if (!cell) {
      warnings.push(`runes: dropped entry with malformed key ${JSON.stringify(rawKey)}`);
      continue;
    }
    const v = raw[rawKey];
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      warnings.push(`runes[${rawKey}]: dropped non-object entry`);
      continue;
    }
    const rune = normalizeRune(cell[0], cell[1], cell[2], /** @type {Partial<Rune>} */ (v));
    const fields = runeToJSON(rune);
    if (Object.keys(fields).length === 0) continue;
    byKey.set(rune.key, fields);
  }
  const keys = [...byKey.keys()].sort(compareKeys);
  /** @type {RunesJSON} */
  const runes = {};
  for (let i = 0; i < keys.length; i++) {
    if (i >= MAX_RUNES) {
      warnings.push(`runes: dropped ${keys.length - MAX_RUNES} entries beyond the cap of ${MAX_RUNES}`);
      break;
    }
    runes[keys[i]] = byKey.get(keys[i]);
  }
  return { runes, warnings };
}

/**
 * normalizeRunesJSON plus the load-time cross-check: a rune block can only exist through an edit (worldgen never
 * emits BLOCK.RUNE_BLOCK), so every entry must correspond to a `[localIndex, RUNE_BLOCK]` pair in `edits` (the
 * repaired EditsJSON of the same save). Orphans are dropped with a warning.
 * @param {unknown} raw
 * @param {Record<string, number[]>} edits
 * @returns {{ runes: RunesJSON, warnings: string[] }}
 */
export function validateRunesJSON(raw, edits) {
  const { runes, warnings } = normalizeRunesJSON(raw);
  /** @type {RunesJSON} */
  const out = {};
  for (const key of Object.keys(runes)) {
    const cell = parseRuneKey(key);
    if (!cell) continue;
    const [q, y, r] = cell;
    if (hasRuneEdit(edits, q, y, r)) out[key] = runes[key];
    else warnings.push(`runes: dropped (${q}, ${y}, ${r}): no rune block there`);
  }
  return { runes: out, warnings };
}

/** True when `edits` records BLOCK.RUNE_BLOCK at cell (q, y, r) (last pair for that local index wins). */
export function hasRuneEdit(edits, q, y, r) {
  if (!edits || typeof edits !== 'object') return false;
  const arr = edits[chunkKey(worldToChunk(q), worldToChunk(r))];
  if (!Array.isArray(arr)) return false;
  const li = localIndex(worldToLocal(q), y, worldToLocal(r));
  let id = -1;
  for (let i = 0; i + 1 < arr.length; i += 2) if (arr[i] === li) id = arr[i + 1];
  return id === BLOCK.RUNE_BLOCK;
}

// ---------------------------------------------------------------------------------------------------
// RuneStore
// ---------------------------------------------------------------------------------------------------

export class RuneStore {
  /** @param {number} [max=MAX_RUNES] */
  constructor(max = MAX_RUNES) {
    /** @type {Map<string, Rune>} */
    this.map = new Map();
    /** bumped on every change; reset to 0 by replaceAll (autosave compares it like World.editVersion) */
    this.version = 0;
    this.max = max;
  }

  get size() {
    return this.map.size;
  }

  /** @returns {Rune|undefined} */
  get(key) {
    return this.map.get(key);
  }

  has(key) {
    return this.map.has(key);
  }

  /** @returns {number} entries that are not pristine (the ones export() writes); only these count toward the cap */
  get storedCount() {
    let n = 0;
    for (const rune of this.map.values()) if (!isDefaultRune(rune)) n++;
    return n;
  }

  /**
   * The rune at (q, y, r), created as a default (pristine) Rune when absent. Pristine entries never count toward
   * the cap (they are not saved either), so this always succeeds.
   * @returns {Rune}
   */
  ensure(q, y, r) {
    const key = runeKey(q, y, r);
    const existing = this.map.get(key);
    if (existing) return existing;
    const rune = normalizeRune(q, y, r, null);
    this.map.set(key, rune);
    this.version++;
    return rune;
  }

  /**
   * Merge the DEFINED fields of `partial` into the rune at (q, y, r) (created when absent), normalising every field.
   * @returns {Rune|null} null when the result would be a new stored (non-pristine) rune beyond the cap
   */
  set(q, y, r, partial) {
    const key = runeKey(q, y, r);
    const existing = this.map.get(key);
    const merged = { ...(existing || {}) };
    for (const k of Object.keys(partial || {})) if (partial[k] !== undefined) merged[k] = partial[k];
    const rune = normalizeRune(q, y, r, merged);
    const wasStored = existing !== undefined && !isDefaultRune(existing);
    if (!wasStored && !isDefaultRune(rune) && this.storedCount >= this.max) return null;
    this.map.set(key, rune);
    this.version++;
    return rune;
  }

  /** @returns {boolean} true when an entry was removed */
  delete(key) {
    const had = this.map.delete(key);
    if (had) this.version++;
    return had;
  }

  clear() {
    if (this.map.size > 0) this.version++;
    this.map.clear();
  }

  /**
   * Replace every entry with the (validated) contents of `json`; version resets to 0 afterwards because restoring
   * a save is not an edit.
   * @param {RunesJSON|null|undefined} json
   * @returns {string[]} warnings
   */
  replaceAll(json) {
    this.map.clear();
    const { runes, warnings } = normalizeRunesJSON(json ?? {});
    for (const key of Object.keys(runes)) {
      const cell = parseRuneKey(key);
      if (!cell) continue;
      this.map.set(key, normalizeRune(cell[0], cell[1], cell[2], runes[key]));
    }
    this.version = 0;
    return warnings;
  }

  /** @returns {RunesJSON} non-pristine runes, non-default fields only, keys sorted by (q, y, r) */
  export() {
    const keys = [...this.map.keys()].sort(compareKeys);
    /** @type {RunesJSON} */
    const out = {};
    for (const key of keys) {
      const fields = runeToJSON(/** @type {Rune} */ (this.map.get(key)));
      if (Object.keys(fields).length > 0) out[key] = fields;
    }
    return out;
  }

  /** @returns {Rune[]} every entry sorted by (q, y, r) */
  list() {
    return [...this.map.keys()].sort(compareKeys).map((k) => /** @type {Rune} */ (this.map.get(k)));
  }

  /**
   * Drop entries whose cell is LOADED and no longer a rune block (never touches cells in unloaded chunks).
   * @param {import('./world.js').World} world
   * @returns {number} entries removed
   */
  sweep(world) {
    let n = 0;
    for (const rune of [...this.map.values()]) {
      if (world.hasChunkAtCell(rune.q, rune.r) && world.getBlock(rune.q, rune.y, rune.r) !== BLOCK.RUNE_BLOCK) {
        this.map.delete(rune.key);
        n++;
      }
    }
    if (n > 0) this.version++;
    return n;
  }
}

// ---------------------------------------------------------------------------------------------------
// RuneRunner
// ---------------------------------------------------------------------------------------------------

/**
 * @typedef {Object} Running  One executing script.
 * @property {string} key          rune key, or `console#N` for a console-issued area job
 * @property {Rune|null} rune
 * @property {ParsedCommand[]} cmds
 * @property {number} cursor
 * @property {number} waitLeft     seconds left of a `wait`
 * @property {number} hops
 * @property {number} wave
 * @property {string} source
 * @property {AreaJob|null} job
 * @property {boolean} [steppedThisFrame]   the job was advanced in the current update (jobs step at most once per frame)
 * @property {number} errors         runtime command failures
 * @property {number} loggedErrors   runtime failures logged so far (capped at MAX_LOGGED_ERRORS)
 * @property {number} loggedParse    parse errors logged so far (separate cap)
 * @property {boolean} dead
 */

/** @typedef {{ commands: number, errors: number, cancelled: boolean, source: string }} RunRecord */

export class RuneRunner {
  /**
   * @param {RuneStore} store
   * @param {CommandContext} ctx   the command context (ctx.rune / ctx.running are set by the runner while executing)
   */
  constructor(store, ctx) {
    this.store = store;
    this.ctx = ctx;
    /** @type {Map<string, Running>} in start order */
    this.running = new Map();
    /** @type {{ key: string, due: number, wave: number, hops: number }[]} FIFO */
    this.pending = [];
    /** after stopall: step / repeat / chain / run triggers are refused until R on a rune, a console run, or resume */
    this.paused = false;
    this.waveCounter = 0;
    /** @type {Map<string, number>} key → last wave the rune ran in */
    this.lastWave = new Map();
    /** @type {Map<string, number>} key → repeat accumulator (seconds) */
    this.repeatAcc = new Map();
    /** @type {Map<string, number>} key → step-on cooldown left (seconds) */
    this.cooldown = new Map();
    /** @type {Set<string>} rune cells that supported the player last frame */
    this.prevSupport = new Set();
    /** set by seedStep(); while pending, phase 5 keeps S_prev and adopts the first GROUNDED support set without firing */
    this.seedPending = false;
    /** @type {Map<string, RunRecord>} */
    this.lastRun = new Map();
    this.consoleJobs = 0;
    /** @type {number[][]} scratch for supportingCells */
    this._support = [];
    /** Assignable: receives every log line (job summaries, console results, script errors). @type {(line: string, isError: boolean) => void} */
    this.onLog = (_line, _isError) => {};
    /** Assignable: fired when a rune script starts. @type {(key: string, source: string) => void} */
    this.onTrigger = (_key, _source) => {};
  }

  /** @param {CommandContext} ctx */
  setContext(ctx) {
    this.ctx = ctx;
  }

  get runningCount() {
    return this.running.size;
  }

  isRunning(key) {
    return this.running.has(key);
  }

  /** @returns {boolean} some script (or console job) is still writing an area command (block physics batches its seeds) */
  hasActiveJobs() {
    for (const run of this.running.values()) if (run.job && !run.dead) return true;
    return false;
  }

  /** @returns {RunRecord|undefined} */
  getLastRun(key) {
    return this.lastRun.get(key);
  }

  /**
   * Start the script of the rune block at `key`.
   * @param {string} key
   * @param {string} source   one of SOURCE
   * @param {{ wave?: number, hops?: number }} [opts]   propagated by chain / run; a root activation gets a new wave
   * @returns {{ ok: boolean, reason?: string }}
   */
  trigger(key, source, opts = {}) {
    const cell = parseRuneKey(key);
    if (!cell) return { ok: false, reason: `invalid rune key "${key}"` };
    const [q, y, r] = cell;
    const world = this.ctx.world;
    const label = `(${q}, ${y}, ${r})`;
    if (!world.hasChunkAtCell(q, r)) return { ok: false, reason: `rune at ${label} is not loaded` };
    if (world.getBlock(q, y, r) !== BLOCK.RUNE_BLOCK) {
      this.store.delete(key);
      return { ok: false, reason: `no rune block at ${label}` };
    }
    const rune = this.store.ensure(q, y, r);
    if (!rune.enabled) return { ok: false, reason: `rune at ${label} is disabled` };
    const root = source === SOURCE.INTERACT || source === SOURCE.CONSOLE;
    if (this.paused && !root) return { ok: false, reason: 'rune triggers are paused (press R on a rune or run resume)' };
    if (this.running.has(key)) return { ok: false, reason: `rune at ${label} is already running` };
    const hops = opts.hops ?? 0;
    if (hops > MAX_CHAIN_HOPS) return { ok: false, reason: `chain limit reached (${MAX_CHAIN_HOPS} hops)` };
    const wave = opts.wave ?? ++this.waveCounter;
    if (this.lastWave.get(key) === wave) return { ok: false, reason: `rune at ${label} already ran in this activation` };
    if (this.running.size >= MAX_RUNNING_SCRIPTS) return { ok: false, reason: `too many running scripts (${MAX_RUNNING_SCRIPTS})` };

    if (root) this.paused = false;
    const parsed = parseScript(rune.script);
    /** @type {Running} */
    const run = {
      key, rune, cmds: parsed.commands, cursor: 0, waitLeft: 0, hops, wave, source, job: null,
      errors: 0, loggedErrors: 0, loggedParse: 0, dead: false,
    };
    for (const e of parsed.errors) this._logError(run, e.line, e.message, true);
    this.running.set(key, run);
    this.lastWave.set(key, wave);
    this.repeatAcc.set(key, 0);
    this.onTrigger(key, source);
    return { ok: true };
  }

  /**
   * Execute one console line synchronously (no rune, no wave). Area commands are queued as a console job that the
   * runner advances under the per-frame cell budget on the following playing frames.
   * @param {string} line
   * @returns {{ ok: boolean, message: string }}
   */
  runConsoleLine(line) {
    const parsed = parseScript(line);
    if (parsed.errors.length) return { ok: false, message: parsed.errors[0].message };
    if (parsed.commands.length === 0) return { ok: true, message: '' };
    const ctx = this.ctx;
    ctx.rune = null;
    ctx.running = null;
    const res = executeCommand(parsed.commands[0], ctx);
    if (res.ok && res.job) {
      if (res.job.done) return { ok: true, message: res.job.summary() };
      const key = `console#${++this.consoleJobs}`;
      this.running.set(key, {
        key, rune: null, cmds: [], cursor: 0, waitLeft: 0, hops: 0, wave: 0, source: SOURCE.CONSOLE, job: res.job,
        errors: 0, loggedErrors: 0, loggedParse: 0, dead: false,
      });
      return { ok: true, message: `${res.job.name}: ${res.job.total} cells queued (runs while you play)` };
    }
    return { ok: res.ok, message: res.message };
  }

  /** Cancel a running script (no chain). @returns {boolean} */
  cancel(key) {
    const run = this.running.get(key);
    if (!run) return false;
    this._finish(run, false, true);
    return true;
  }

  /** @returns {number} scripts cancelled */
  cancelAll() {
    let n = 0;
    for (const run of [...this.running.values()]) {
      this._finish(run, false, true);
      n++;
    }
    this.pending.length = 0;
    return n;
  }

  /** `stopall`: cancel everything and pause every automatic trigger. @returns {number} scripts cancelled */
  stopAll() {
    const n = this.cancelAll();
    this.paused = true;
    return n;
  }

  resume() {
    this.paused = false;
  }

  /** Forget everything (new world / quit): nothing runs, no timers, no cooldowns, no history. */
  reset() {
    this.running.clear();
    this.pending.length = 0;
    this.paused = false;
    this.waveCounter = 0;
    this.lastWave.clear();
    this.repeatAcc.clear();
    this.cooldown.clear();
    this.prevSupport.clear();
    this.seedPending = false;
    this.lastRun.clear();
    this.consoleJobs = 0;
  }

  /**
   * Treat the cells currently under the player's footprint as already entered (after spawn / teleport: arriving is
   * not stepping on). Ignores `onGround` on purpose: a teleport clears it, and the landing frame must not count. The
   * seed stays pending until the player is grounded again — a teleport executed by a script runs in the middle of
   * update(), and a mid-air destination has nothing under the footprint until the player has fallen onto it.
   */
  seedStep() {
    this.prevSupport = this._currentSupport(true);
    this.seedPending = true;
  }

  /**
   * One frame of script execution, in this order: (1) cancel scripts whose loaded cell is no longer a rune block,
   * (2) advance running scripts round-robin under the command and cell budgets (waits expire first; a script whose
   * wait just ended resumes this frame), (3) fire due chain entries FIFO, (4) repeat timers, (5) step-on.
   * @param {number} dt seconds (already clamped by the caller)
   * @returns {{ executed: number, fired: number }}
   */
  update(dt) {
    if (!(dt > 0)) dt = 0;
    const ctx = this.ctx;
    const world = ctx.world;
    let executed = 0;
    let fired = 0;

    // 1. Safety net for writers that bypass the onBlockChange hook.
    for (const run of [...this.running.values()]) {
      if (!run.rune) continue;
      const { q, y, r } = run.rune;
      if (world.hasChunkAtCell(q, r) && world.getBlock(q, y, r) !== BLOCK.RUNE_BLOCK) {
        this._finish(run, false, true);
        this.store.delete(run.key);
      }
    }

    // 2. Advance.
    const snapshot = [...this.running.values()];
    for (const run of snapshot) {
      run.steppedThisFrame = false;
      if (run.waitLeft > 0) {
        run.waitLeft -= dt;
        if (run.waitLeft <= 0) run.waitLeft = 0;
      }
    }
    let budgetCmds = MAX_COMMANDS_PER_FRAME;
    let budgetCells = MAX_CELLS_PER_FRAME;
    let progress = true;
    while (progress && budgetCmds > 0 && budgetCells > 0) {
      progress = false;
      for (const run of snapshot) {
        if (run.dead || run.waitLeft > 0) continue;
        if (run.job && run.steppedThisFrame) continue; // one step per job per frame: the chunk-column bound is per frame
        if (budgetCmds <= 0 || budgetCells <= 0) break;
        progress = true;
        if (run.job) {
          run.steppedThisFrame = true;
          budgetCells -= run.job.step(budgetCells);
          if (run.job.done) {
            this._log(run, run.job.summary());
            run.job = null;
            run.cursor++;
            if (run.cursor >= run.cmds.length) this._finish(run, true, false);
          }
          continue;
        }
        if (run.cursor >= run.cmds.length) {
          this._finish(run, true, false);
          continue;
        }
        const cmd = run.cmds[run.cursor];
        budgetCmds--;
        executed++;
        ctx.rune = run.rune;
        ctx.running = run;
        const res = executeCommand(cmd, ctx);
        ctx.rune = null;
        ctx.running = null;
        if (run.dead) continue; // cancelled by the command itself (e.g. it replaced its own block)
        if (!res.ok) {
          run.errors++;
          this._logError(run, cmd.line, res.message);
          run.cursor++;
        } else if (res.job) {
          run.job = res.job;
          run.steppedThisFrame = false; // it may take its first step this frame
          if (res.job.done) {
            this._log(run, res.job.summary());
            run.job = null;
            run.cursor++;
          }
        } else {
          if (res.message && run.source === SOURCE.CONSOLE) this.onLog(res.message, false);
          run.cursor++;
          if (res.stop) {
            this._finish(run, false, false);
            continue;
          }
          if (res.wait) {
            run.waitLeft = res.wait;
            continue;
          }
        }
        if (!run.dead && !run.job && run.cursor >= run.cmds.length) this._finish(run, true, false);
      }
    }

    // 3. Chains.
    if (this.pending.length) {
      const due = [];
      const keep = [];
      for (const e of this.pending) {
        e.due -= dt;
        if (e.due <= 0) due.push(e);
        else keep.push(e);
      }
      this.pending = keep;
      for (const e of due) {
        if (this.trigger(e.key, SOURCE.CHAIN, { wave: e.wave, hops: e.hops }).ok) fired++;
      }
    }

    // 4. Repeat timers (frozen while the chunk is unloaded; held at 0 while the script runs).
    for (const rune of this.store.list()) {
      if (!rune.enabled || !rune.repeat) continue;
      if (!world.hasChunkAtCell(rune.q, rune.r)) continue;
      if (this.running.has(rune.key)) {
        this.repeatAcc.set(rune.key, 0);
        continue;
      }
      let acc = (this.repeatAcc.get(rune.key) || 0) + dt;
      if (acc >= rune.repeatInterval) {
        acc = 0;
        if (!this.paused && this.trigger(rune.key, SOURCE.REPEAT).ok) fired++;
      }
      this.repeatAcc.set(rune.key, Math.min(acc, rune.repeatInterval));
    }

    // 5. Step-on: edge-triggered on the set of rune cells supporting the player.
    for (const [key, left] of this.cooldown) {
      const next = left - dt;
      if (next <= 0) this.cooldown.delete(key);
      else this.cooldown.set(key, next);
    }
    const support = this._currentSupport();
    if (this.seedPending) {
      // Arrived by spawn/teleport (possibly mid-air, possibly from inside a script this very frame): do not let the
      // airborne/empty set replace the seed; adopt the set on the first grounded frame without firing anything.
      if (ctx.player && ctx.player.onGround) {
        this.seedPending = false;
        this.prevSupport = support;
      }
      return { executed, fired };
    }
    for (const key of support) {
      if (this.prevSupport.has(key)) continue;
      const rune = this.store.get(key);
      if (!rune || !rune.enabled || !rune.stepOn || this.cooldown.has(key) || this.paused) continue;
      if (this.trigger(key, SOURCE.STEP).ok) {
        fired++;
        if (rune.stepCooldown > 0) this.cooldown.set(key, rune.stepCooldown);
      }
    }
    this.prevSupport = support;

    return { executed, fired };
  }

  // ---- internals -----------------------------------------------------------------------------------

  /**
   * @param {boolean} [ignoreGround=false]  also report the cells under an airborne player (used to seed after a teleport)
   * @returns {Set<string>} keys of the rune blocks the player is standing on right now
   */
  _currentSupport(ignoreGround = false) {
    const ctx = this.ctx;
    const set = new Set();
    if (!ctx.player || (!ignoreGround && !ctx.player.onGround)) return set;
    const cells = supportingCells(ctx.player, ctx.world.getBlock, this._support);
    for (const c of cells) {
      if (ctx.world.getBlock(c[0], c[1], c[2]) === BLOCK.RUNE_BLOCK) set.add(runeKey(c[0], c[1], c[2]));
    }
    return set;
  }

  /**
   * End a script. `chain` requests the chain fan-out (only when the rune has `chain`); `cancelled` records it.
   * @param {Running} run @param {boolean} chain @param {boolean} cancelled
   */
  _finish(run, chain, cancelled) {
    if (run.dead) return;
    run.dead = true;
    this.running.delete(run.key);
    this.lastRun.set(run.key, { commands: run.cursor, errors: run.errors, cancelled, source: run.source });
    // Use the LIVE store entry: the editor's store.set replaces the object mid-run, and Chain/Enabled turned off
    // while the script was running must be honoured.
    const rune = run.rune && (this.store.get(run.key) ?? run.rune);
    if (!chain || cancelled || !rune || !rune.chain || !rune.enabled) return;
    for (let f = 0; f < FACE_COUNT; f++) {
      const [nq, ny, nr] = faceNeighbor(rune.q, rune.y, rune.r, f);
      if (!inHeightRange(ny)) continue;
      this.pending.push({ key: runeKey(nq, ny, nr), due: CHAIN_DELAY_S, wave: run.wave, hops: run.hops + 1 });
    }
  }

  /** @param {Running} run @param {string} message */
  _log(run, message) {
    if (!message) return;
    this.onLog(run.rune ? `[${run.rune.q},${run.rune.y},${run.rune.r}] ${message}` : message, false);
  }

  /**
   * Log a parse or runtime error of a script, each kind capped at MAX_LOGGED_ERRORS per run (the first excess of a
   * kind is replaced by one "… more <kind> errors suppressed" line).
   * @param {Running} run @param {number} line @param {string} message @param {boolean} [parse=false]
   */
  _logError(run, line, message, parse = false) {
    const count = parse ? ++run.loggedParse : ++run.loggedErrors;
    if (count > MAX_LOGGED_ERRORS) {
      if (count === MAX_LOGGED_ERRORS + 1) this._log(run, `… more ${parse ? 'parse' : 'command'} errors suppressed`);
      return;
    }
    this.onLog(run.rune ? `[${run.rune.q},${run.rune.y},${run.rune.r}:${line}] ${message}` : `line ${line}: ${message}`, true);
  }
}
