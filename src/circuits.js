// Caelancraft — the circuit engine: powder fuses and the flame rule, and a single-wire, earth-return electrical model that
// obeys Ohm's law (every wire cell drops WIRE_OHMS × ⌈I_net⌉), with batteries that tire, piles, switches, buttons, clockwork
// timers, relays, igniters, lamps, bells and spark radio. docs/DESIGN-circuits.md §4.3–§4.9, §6.2.3 (CONTRACTS §52 once
// merged). PURE: no DOM, no three, no Math.random and no clock of its own (hooks.now is read for the tick budget and the
// stats only); every world access goes through the hooks.
//
// THE TICK. step(dt) runs at most 2 CIRCUIT_TICK_S (50 ms) ticks per call. Each tick, in order: (1) clocks (button presses,
// relay hand-pushes and delayed flips, timers, the blaster, radio arrivals and receiver pulses, igniter refires: loaded cells
// only); (2) burning fuses; (3) the flame queue; (4) selenium panels, every 20th tick; (5) networks: every network touched by
// a dirty cell is rebuilt (BFS through the `cells` index, Dial's bucket queue for the volts), then the loads on them are
// evaluated and their EDGES act (igniters fire, transmitters send, timers start, tappers tap, relay coils schedule their flip
// one tick later); (6) deferred effects: burnt fuse cells → AIR (≤ 32) and ignitions (≤ 32); (7) battery drain; (8) every 20th
// tick, networks that reach into an unloaded chunk are frozen. State changes only at tick boundaries, so nothing recurses.
// Every clock counts whole ticks; a countdown the player starts between ticks (a button press, a hand-push, a plunge) gets one
// extra tick, so a 0.3 s click closes a button for exactly 6 ticks.
//
// BUDGET. Networks are rebuilt until MAX_CIRCUIT_VISITS_PER_TICK cell visits or CIRCUIT_TICK_BUDGET_MS (hooks.now) are spent,
// checked between networks; the remaining dirty cells wait, FIFO. Each dirty mark remembers the build serial of its change, so
// a network built after it is reused: a burst of changes in one big network (a `fill` of wire) rebuilds it once.
//
// SETTLING. Cells dirtied by loadFromEdits, onChunkLoaded or setEnabled(true), and networks that meet an unloaded cell, are
// solved with no edge actions: relays take their coil's settled state at once (up to MAX_SETTLE_PASSES passes), selenium is
// evaluated at once, and loads simply take their current state. A network that reaches an unloaded chunk (or that touches a
// relay whose coil cannot be known yet) is FROZEN: it keeps its last voltages, takes no edges and drains nothing until it is
// whole again. Loading never fires anything (CONTRACTS pitfall 37).
//
// The user named the design's "Linstock" a Torch (block TORCH, key `torch`): a flame that is always lit (circuitParts.js).
import {
  CIRCUIT_TICK_S, VOLT_UNIT, WIRE_OHMS, BATTERY_V, BATTERY_EMPTY_V, BATTERY_KNEE, MAX_PILE, BLASTER_V, SELENIUM_MAX_V,
  LAMP_MIN_V, LAMP_FULL_V, BATTERY_CAPACITY, EARTH_WALK_CELLS, IGNITER_REFIRE_S, RELAY_DELAY_TICKS, RELAY_HAND_S,
  BUTTON_PULSE_S, BUTTON_RELEASE_S, BLASTER_PULSE_S, BLASTER_RESET_S, TIMER_DEFAULT_S, TIMER_MIN_S, TIMER_MAX_S, TIMER_PULSE_S,
  RADIO_RANGE, RADIO_PULSE_S, FUSE_CELL_S, MAX_BURNING_FUSES, MAX_FLAME_QUEUE, MAX_FUSE_SPARK_CELLS, MAX_FUSE_PUFFS_PER_TICK,
  MAX_CIRCUIT_VISITS_PER_TICK, CIRCUIT_TICK_BUDGET_MS, MAX_NETWORK_CELLS, MAX_CONTACT_CHANGES_PER_TICK, MAX_SETTLE_PASSES,
  MAX_CIRCUIT_WRITES_PER_TICK, MAX_IGNITIONS_PER_TICK, MAX_CIRCUIT_OVERLAYS, WORLD_HEIGHT, BARREL_FUSE_S, RADIO_DISTRESS_CH,
  PHYSICS_SOUND_RANGE, CHUNK_SIZE,
} from './config.js';
import { BLOCK, UNLOADED, getBlockDef, isOpaque } from './blocks.js';
import { chunkKey, indexToLocal, packCell, parseChunkKey, worldToChunk } from './coords.js';
import { FACE_OPPOSITE, HEX_DIRS, HEX_ROW_SPACING } from './hex.js';
import { hash3 } from './noise.js';
import {
  DEFAULT_INPUT_FACE, PARTS, conductorAccepts, isEarth, isFlame, isIgnitable, isPart, liveFaces, partOf, partOrigin, partTip,
  parseChannel, wavelengthOf,
} from './circuitParts.js';
import { partKey } from './circuitStore.js';

/** @typedef {import('./circuitStore.js').CircuitStore} CircuitStore */
/** @typedef {import('./types.js').PartState} PartState */
/** @typedef {import('./types.js').OverlayItem} OverlayItem */
/** @typedef {import('./types.js').DevicePanelView} DevicePanelView */

/**
 * What the engine may touch (main builds it, DESIGN-circuits §6.6). Every hook but `peek`, `setBlock`, `isLoaded` and `isEdit`
 * is optional (a no-op or a refusal when absent).
 * @typedef {Object} CircuitHooks
 * @property {(q: number, y: number, r: number) => number} peek        World.peekBlock (UNLOADED for an unloaded chunk)
 * @property {(q: number, y: number, r: number, id: number) => boolean} setBlock   a LAZY world write (burnt fuse cells)
 * @property {(q: number, r: number) => boolean} isLoaded               the chunk of column (q, r) is loaded
 * @property {(q: number, y: number, r: number) => boolean} isEdit      the cell is in world.edits (the earth walk)
 * @property {() => number} [now]                                       ms clock: the tick budget and stats().ms only
 * @property {(q: number, y: number, r: number, fuse?: number) => IgniteResult} [igniteKeg]
 *   explosions.igniteInPlace (default fuse KEG_DIRECT_FUSE_S; `ignite` passes BARREL_FUSE_S)
 * @property {(q: number, y: number, r: number) => IgniteResult} [activateCharge]   blackHoles.activate
 * @property {(q: number, y: number, r: number) => boolean} [kegBurning]           explosions.isBurning (overlays)
 * @property {(q: number, y: number, r: number) => boolean} [chargeArming]         the charge there is collapsing (hints)
 * @property {() => number} [daylight]                                  0..1 (selenium panels)
 * @property {(name: string, x: number, y: number, z: number, volume?: number) => void} [sound]
 * @property {(kind: string, x: number, y: number, z: number, count?: number, opts?: object) => void} [particles]
 * @property {(text: string) => void} [say]
 *
 * CONTRACT-ISSUE: three differences from §6.2.3 / §6.6 for the integrator:
 * - igniteKeg takes a 4th argument, the fuse: `ignite q y r` must light a keg for BARREL_FUSE_S (3 s) through
 *   circuits.ignite (§6.5), but §6.6's hook `(q, y, r) => explosions.igniteInPlace(q, y, r)` would drop it. Main should
 *   write `(q, y, r, fuse) => explosions.igniteInPlace(q, y, r, fuse)` (undefined → KEG_DIRECT_FUSE_S).
 * - chargeArming is new and optional: `Collapsar Charge · collapsing!` (§4.9) needs to know the charge is arming, which
 *   only blackholes.js knows (main: a check of blackHoles' arming set). Without it the hint always says dormant.
 * - The hooks carry no player position, yet §4.3 / §4.6 / §4.12 want sparks and repeating sounds at the burning fuse, bell
 *   or timer NEAREST the player: the engine uses the eye of the last overlays(x, y, z, …) call (main calls it every frame).
 */
/** @typedef {{ ok: boolean, message: string, quiet?: boolean }} IgniteResult */

const B = BLOCK;
const TICK = CIRCUIT_TICK_S;

// Per-id tables for the network BFS (the hot loop): what kind of electrical cell an id is, its signal wire kind (1 copper,
// 2 brown, 3 white; 0 any for boards and contacts), whether it has an input face, and its current (amps). From PARTS.
const K_NONE = 0;
const K_WIRE = 1;
const K_JUNCTION = 2;
const K_CONTACT = 3;
const K_SOURCE = 4;
const K_LOAD = 5;
const KIND = new Uint8Array(256);
const SIG = new Uint8Array(256);
const INPUT = new Uint8Array(256);
const AMPS = new Float64Array(256);
for (const p of Object.values(PARTS)) {
  if (p.role === 'wire') {
    if (p.wire !== 'earth') {
      KIND[p.id] = K_WIRE;
      SIG[p.id] = ['copper', 'brown', 'white'].indexOf(/** @type {string} */ (p.wire)) + 1;
    }
  } else if (p.role === 'junction') KIND[p.id] = K_JUNCTION;
  else if (p.role === 'contact') KIND[p.id] = K_CONTACT;
  else if (p.role === 'source') KIND[p.id] = K_SOURCE;
  else if (p.role === 'load') KIND[p.id] = K_LOAD;
  else KIND[p.id] = K_NONE;
  if (p.input) INPUT[p.id] = 1;
  AMPS[p.id] = p.amps ?? 0;
}
/** Axial steps of the six side faces. */
const DQ = HEX_DIRS.map((d) => d[0]);
const DR = HEX_DIRS.map((d) => d[1]);
/** @returns {number} seconds → whole ticks (at least 1) */
const ticksOf = (s) => Math.max(1, Math.round(s / TICK));
const FUSE_TICKS = ticksOf(FUSE_CELL_S);
const BUTTON_PULSE_TICKS = ticksOf(BUTTON_PULSE_S);
const BUTTON_RELEASE_TICKS = ticksOf(BUTTON_RELEASE_S);
const RELAY_HAND_TICKS = ticksOf(RELAY_HAND_S);
const BLASTER_PULSE_TICKS = ticksOf(BLASTER_PULSE_S);
const BLASTER_RESET_TICKS = ticksOf(BLASTER_RESET_S);
const TIMER_PULSE_TICKS = ticksOf(TIMER_PULSE_S);
const RADIO_PULSE_TICKS = ticksOf(RADIO_PULSE_S);
const IGNITER_REFIRE_TICKS = ticksOf(IGNITER_REFIRE_S);
const TX_FLASH_TICKS = ticksOf(0.15);
const RX_GLOW_TICKS = ticksOf(0.3);
const HISS_TICKS = ticksOf(0.4);
const TIMER_TICK_TICKS = ticksOf(0.5);
const BELL_STRIKE_S = 0.12;
const SAY_GAP_TICKS = ticksOf(4);
const SLOW_EVERY = 20; // selenium and the unload check run every 20th tick (1 s)
const BELL_RANGE = PHYSICS_SOUND_RANGE;
const TIMER_TICK_RANGE = 12;
/** Volts → whole VOLT_UNITs. */
const units = (v) => Math.round(v / VOLT_UNIT);
const UNITS_PER_AMP = Math.max(1, Math.round(WIRE_OHMS / VOLT_UNIT));
const BLASTER_UNITS = units(BLASTER_V);
const LAMP_MIN_UNITS = units(LAMP_MIN_V);
/** OverlayItem.b of a keg's bung glow (circuitGeometry.FUSE_AT_BUNG: the spark sits on a keg burning in place). */
const FUSE_AT_BUNG = 8;

// Packed cell arithmetic (coords.packCell: ((q + 2^20)·2^21 + (r + 2^20))·128 + y): a neighbour is pc + a constant.
const H = WORLD_HEIGHT;
const SPAN = 1 << 21;
const OFF = 1 << 20;
const QS = SPAN * H;
const NB = [QS, H, -QS + H, -QS, -H, QS - H, 1, -1];
/** @returns {number} the packed neighbour across `face` (0..7), or −1 above the top / below the bottom of the world */
function nb(pc, face) {
  if (face === 6) return pc % H === H - 1 ? -1 : pc + 1;
  if (face === 7) return pc % H === 0 ? -1 : pc - 1;
  return pc + NB[face];
}
const yOf = (pc) => pc % H;
const rOf = (pc) => ((pc - (pc % H)) / H) % SPAN - OFF;
const qOf = (pc) => ((pc - (pc % H)) / H - (((pc - (pc % H)) / H) % SPAN)) / SPAN - OFF;
const xOf = (pc) => qOf(pc) + rOf(pc) / 2;
/** @returns {number} a numeric id of the chunk holding packed cell pc (the loaded cache, networks' chunk sets) */
const chunkIdOf = (pc) => (worldToChunk(qOf(pc)) + 65536) * 131072 + (worldToChunk(rOf(pc)) + 65536);
/** @returns {[number, number]} the chunk (cq, cr) of a chunkIdOf id */
const chunkOfId = (id) => [Math.floor(id / 131072) - 65536, (id % 131072) - 65536];
const zOf = (pc) => rOf(pc) * HEX_ROW_SPACING;
const cellText = (pc) => `(${qOf(pc)}, ${yOf(pc)}, ${rOf(pc)})`;

// Timer phases (not saved; `on` and `run` are).
const T_IDLE = 0;
const T_COUNT = 1;
const T_PULSE = 2;
const T_HOLD = 3;
const T_RCLOSED = 4;
const T_ROPEN = 5;

const CIRCUITS_OFF = 'circuits are off — turn them on with `circuits on`';
const TRUNCATED = `This circuit is larger than ${MAX_NETWORK_CELLS} cells; split it with relays.`;
const TOO_MANY = 'too many configured devices in this world';
const BYPASSED = 'bypassed: the wires on either side touch — run them out of opposite faces, or use brown on one side and white on the other';
const SELF_FED = 'its own battery feeds the coil — move the battery away from the input face';
const NO_WIRE = '0 V: join it to the battery with a wire';
const STRAP_NOT_GROUNDED = 'not earthed: its Earth Wire is not grounded — run it down to soil or stone';
const WOOD_NAMES = /(_log|_planks)$|^bookshelf$/;

/** @returns {string} volts for hints: two decimals at most, trailing zeros dropped (5.44 V, 2.25 V, 6 V) */
export function formatVolts(u) {
  return `${Math.round(u * VOLT_UNIT * 100) / 100} V`;
}
/** @returns {string} the exact voltage (`volts` prints 5.4375 V) */
export function exactVolts(u) {
  return `${u * VOLT_UNIT} V`;
}
/** @returns {string} seconds with at most one decimal: 10 s, 7.2 s */
function formatSeconds(s) {
  return `${Math.round(s * 10) / 10} s`;
}
/** @returns {number} a battery's voltage in VOLT_UNITs at charge c (§4.4): flat 6 V down to the knee, 4.5 V at empty, 0 when flat */
export function batteryUnits(c) {
  if (!(c > 0)) return 0;
  const empty = BATTERY_EMPTY_V / BATTERY_V;
  const v = BATTERY_V * (empty + (1 - empty) * Math.min(1, c / (BATTERY_KNEE * BATTERY_CAPACITY)));
  return Math.floor(v / VOLT_UNIT + 1e-9);
}
/** @returns {number} the closed time of a repeat timer of period sTicks (§4.6): ⌊s/2⌋ clamped to 1 tick … TIMER_PULSE_S */
export function repeatClosedTicks(sTicks) {
  return Math.min(TIMER_PULSE_TICKS, Math.max(1, Math.floor(sTicks / 2)));
}
/** @returns {number} a seeded 0..1 per cell (overlay variety) */
function seedOf(pc) {
  return hash3(qOf(pc), yOf(pc), rOf(pc), 0x51c) / 4294967296;
}
/** The display name of a block, for messages. */
function nameOf(id) {
  return getBlockDef(id).displayName;
}

/**
 * One electrical network: a connected set of conductor cells (§4.5) with its attached sources and loads and its solved
 * voltages (whole VOLT_UNITs per node).
 * @typedef {Object} Net
 * @property {number} id
 * @property {number} serial      the build pass it was made in
 * @property {boolean} alive
 * @property {number[]} nodes     packed cells
 * @property {Map<number, number>} idx   packed cell → node index
 * @property {Int16Array} units
 * @property {Int32Array} seg     union-find root of each node over wire–wire / wire–board / board–board edges (§4.5)
 * @property {number[]} sources   attached active sources (packed cells)
 * @property {number[]} srcUnits  their output, in units
 * @property {number} maxSrc      the highest source output (units)
 * @property {number[]} loads     attached earthed loads and inputs (packed cells)
 * @property {number} amps        I_net
 * @property {number} w           units dropped per wire cell
 * @property {boolean} partial    the BFS met an unloaded cell
 * @property {boolean} truncated  more than MAX_NETWORK_CELLS
 * @property {boolean} frozen     keeps its last voltages, no edges, no drain (partial, unloaded since, or an uncertain relay)
 * @property {boolean} settle     built from a settling seed: no edge actions this pass
 * @property {Set<number>} chunks chunk ids (chunkIdOf) of its nodes and attached devices (the unload check)
 */

export class Circuits {
  /**
   * @param {CircuitStore} store   the world's side table (main's circuitStore, filled by replaceAll before loadFromEdits)
   * @param {CircuitHooks} hooks
   */
  constructor(store, hooks) {
    this.store = store;
    /** @type {CircuitHooks} */
    this.hooks = hooks;
    /** the per-world switch (saved); off: no ticks, no flame dispatch */
    this.enabled = true;
    /** bumps when `enabled` changes (main's autosave watches it) */
    this.switchVersion = 0;
    /** bumps whenever the drawn wiring may change (a part added or removed, an input face, an earth-wire clamp) */
    this.geometryVersion = 0;
    /** ticks run so far */
    this.tickCount = 0;

    /** @type {Map<number, number>} every part, keg and flame cell (packed) → its block id: the index (§4.7) */
    this.cells = new Map();
    /** @type {Map<string, Set<number>>} chunk key → indexed cells */
    this.byChunk = new Map();
    /** @type {Set<number>} receivers, panels and batteries (radio, selenium refresh) */
    this._rxCells = new Set();
    this._selCells = new Set();
    /** @type {Map<number, *>} per-cell runtime state (not saved) */
    this.rt = new Map();
    /** @type {Set<number>} cells with a running clock */
    this._clocks = new Set();

    /** @type {Map<number, { ticks: number, total: number, from: number, start: number }>} burning fuse cells */
    this.burning = new Map();
    /** @type {Set<number>} fuse cells that finished and wait for their AIR write */
    this.spent = new Set();
    /** @type {number[]} spent cells to write AIR */
    this._writeQ = [];
    /** @type {{ pc: number, from: number, src: number }[]} the flame queue (§4.3) */
    this._flameQ = [];
    this._flameSet = new Set();
    /** @type {{ pc: number, kind: 'fuse'|'keg'|'charge', from: number, src: number, srcId: number }[]} deferred ignitions */
    this._ignQ = [];

    // networks
    /** @type {Map<number, Net>} conductor cell → its network */
    this.nodeNet = new Map();
    /** @type {Set<Net>} */
    this.networks = new Set();
    this._netId = 0;
    this._serial = 0;
    /** @type {number[]} BFS seeds waiting (packed cells) and their settle flags */
    this._seeds = [];
    this._seedSettle = [];
    /** @type {number[]} the build serial of the change each seed stands for */
    this._seedMark = [];
    this._seedHead = 0;
    /** @type {Map<number, number>} dirty cell → the build serial when it was marked */
    this._dmark = new Map();
    // dirty cells: the main FIFO (with each cell's settle flag), and during step 5 the ones that wait for the next pass/tick
    this._dq = [];
    this._dqHead = 0;
    /** @type {Map<number, boolean>} */
    this._dflag = new Map();
    /** @type {Map<number, boolean>} */
    this._settleNext = new Map();
    /** @type {Map<number, boolean>} */
    this._later = new Map();
    this._inNetworks = false;
    /** @type {Map<number, boolean>} loads to evaluate after this pass's rebuilds → settle flag */
    this._evalSet = new Map();

    // earth
    /** @type {Map<number, { ok: boolean, reason: string }>} */
    this._earthCache = new Map();
    /** @type {Map<number, { cells: number[], grounded: boolean }>} earth-wire cell → its earth net */
    this._earthNets = new Map();
    /** @type {Map<number, boolean>} earth-wire cell → its own walk passes (the clamp) */
    this._groundCache = new Map();

    /** @type {Map<number, boolean>} chunk id (chunkIdOf) → loaded, cleared every tick */
    this._loadedCache = new Map();
    /** @type {Set<number>} nodes of truncated networks already announced */
    this._truncSaid = new Set();
    /** @type {Map<string, number>} chat throttle: cause → tick it was said */
    this._said = new Map();
    /** @type {number[]|null} the eye position last given to overlays() (nearest-first sounds and sparks) */
    this._eye = null;
    this._bellAcc = 0;
    this._t0 = 0;
    this._visits = 0;
    this._contactChanges = 0;
    this._acc = 0;
    this._stats = { visits: 0, ms: 0 };
    /** @type {*} */
    this._view = null;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // switches and lifecycle

  /**
   * The per-world switch (§4.7, saved). Off freezes everything: no ticks, no flame dispatch. On again marks every part
   * dirty for SETTLING (nothing fires from switching on) and re-queues the flame candidates.
   * @param {boolean} on
   * @returns {boolean} it changed
   */
  setEnabled(on) {
    const v = Boolean(on);
    if (v === this.enabled) return false;
    this.enabled = v;
    this.switchVersion++;
    if (v) {
      this._loadedCache.clear();
      for (const pc of this.cells.keys()) this._markDirty(pc, true);
      this._queueAllFlames();
    }
    return true;
  }

  /**
   * Build the index (§4.7) from World.edits (Map<chunkKey, Map<localIndex, id>>, or an EditsJSON object): every cell whose id
   * is a part, the keg or a flame. Everything is dirtied for SETTLING and every ignitable with a flame neighbour is queued.
   * Transient state (burning fuses, presses, pulses, networks) starts empty; timers latched in `hold` and running `repeat`
   * clocks come back from the store.
   * @param {Map<string, Map<number, number>>|Record<string, number[]>} edits
   */
  loadFromEdits(edits) {
    this.clear();
    const add = (key, li, id) => {
      if (partOf(id) === null) return;
      const [cq, cr] = parseChunkKey(key);
      if (!Number.isInteger(cq) || !Number.isInteger(cr) || !Number.isInteger(li)) return;
      const [lq, ly, lr] = indexToLocal(li);
      this._indexAdd(packCell(cq * CHUNK_SIZE + lq, ly, cr * CHUNK_SIZE + lr), id);
    };
    if (edits instanceof Map) {
      for (const [key, m] of edits) for (const [li, id] of m) add(key, li, id);
    } else if (edits && typeof edits === 'object') {
      for (const key of Object.keys(edits)) {
        const arr = edits[key];
        if (Array.isArray(arr)) for (let i = 0; i + 1 < arr.length; i += 2) add(key, arr[i], arr[i + 1]);
      }
    }
    for (const pc of this.cells.keys()) this._markDirty(pc, true);
    if (this.enabled) this._queueAllFlames();
    this.geometryVersion++;
  }

  /**
   * Every block change from any source (main forwards World.onBlockChange). BOOKKEEPING ONLY — it runs inside World.setBlock,
   * so it never writes, never calls a hook (CONTRACTS pitfall 34): the index; the store entry (a part leaving deletes its
   * entry, §4.8); `spent`; the cell and its 8 neighbours dirty; every earth-needing part or earth wire in the 9 cells above
   * dirty (their earth walk may have changed); flame candidates queued.
   */
  onBlockChange(q, y, r, prev, next) {
    if (!(y >= 0 && y < H) || prev === next) return;
    const pc = packCell(q, y, r);
    const prevIdx = partOf(prev) !== null;
    const nextIdx = partOf(next) !== null;
    this.spent.delete(pc);
    if (prevIdx || this.cells.has(pc)) {
      this._indexRemove(pc);
      if (this.store.has(partKey(q, y, r))) this.store.delete(partKey(q, y, r));
    }
    if (nextIdx) {
      this._indexAdd(pc, next);
      const p = /** @type {*} */ (partOf(next));
      if (p.fields.length > 0) this.store.ensure(q, y, r, p.key);
    }
    if (prevIdx || nextIdx) this.geometryVersion++;
    // Earth wires: a change here (or anywhere below one) can merge, split or ground an earth net.
    if (prev === B.EARTH_WIRE || next === B.EARTH_WIRE) {
      this._invalidateEarthNet(pc);
      for (let f = 0; f < 8; f++) {
        const n = nb(pc, f);
        if (n >= 0 && this.cells.get(n) === B.EARTH_WIRE) this._invalidateEarthNet(n);
      }
    }
    for (let k = 1; k <= EARTH_WALK_CELLS + 1 && y + k < H; k++) {
      const a = pc + k;
      const id = this.cells.get(a);
      if (id === undefined) continue;
      if (id === B.EARTH_WIRE) {
        this._invalidateEarthNet(a);
        this.geometryVersion++;
      } else if (/** @type {*} */ (partOf(id)).earth) this._markDirty(a, false);
    }
    if (!this.enabled) return;
    this._markDirty(pc, false);
    for (let f = 0; f < 8; f++) {
      const n = nb(pc, f);
      if (n >= 0 && this.cells.has(n)) this._markDirty(n, false);
    }
    if (nextIdx) this._queueFlameFor(pc, next);
  }

  /**
   * A chunk was (re)generated and is loaded: its indexed cells are dirtied for SETTLING (frozen networks reaching into it are
   * solved again), its flame candidates re-queued and its earth nets re-checked. Clocks resume by themselves.
   */
  onChunkLoaded(cq, cr) {
    this._loadedCache.clear();
    const set = this.byChunk.get(chunkKey(cq, cr));
    if (!set) return;
    for (const pc of set) {
      if (this.cells.get(pc) === B.EARTH_WIRE) this._invalidateEarthNet(pc, true);
      this._markDirty(pc, true);
      if (this.enabled && isIgnitable(this.cells.get(pc) ?? 0)) this._queueFlameFor(pc, /** @type {number} */ (this.cells.get(pc)));
    }
  }

  /** Drop the transient state (burning fuses, queues, presses, pulses, networks); the index and the store stay. Everything is dirtied for settling. */
  reset() {
    this.rt.clear();
    this._clocks.clear();
    this.burning.clear();
    this.spent.clear();
    this._writeQ.length = 0;
    this._flameQ.length = 0;
    this._flameSet.clear();
    this._ignQ.length = 0;
    this.nodeNet.clear();
    this.networks.clear();
    this._seeds.length = 0;
    this._seedSettle.length = 0;
    this._seedMark.length = 0;
    this._seedHead = 0;
    this._dmark.clear();
    this._dq.length = 0;
    this._dqHead = 0;
    this._dflag.clear();
    this._settleNext.clear();
    this._later.clear();
    this._evalSet.clear();
    this._earthCache.clear();
    this._earthNets.clear();
    this._groundCache.clear();
    this._loadedCache.clear();
    this._truncSaid.clear();
    this._said.clear();
    this._acc = 0;
    this._bellAcc = 0;
    for (const pc of this.cells.keys()) this._markDirty(pc, true);
  }

  /** Forget everything but the store (main's quitToTitle; loadFromEdits starts with it). */
  clear() {
    this.reset();
    this._dq.length = 0;
    this._dqHead = 0;
    this._dflag.clear();
    this._dmark.clear();
    this.cells.clear();
    this.byChunk.clear();
    this._rxCells.clear();
    this._selCells.clear();
    this.geometryVersion++;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // the index

  _indexAdd(pc, id) {
    this.cells.set(pc, id);
    const ck = chunkKey(worldToChunk(qOf(pc)), worldToChunk(rOf(pc)));
    let set = this.byChunk.get(ck);
    if (!set) this.byChunk.set(ck, (set = new Set()));
    set.add(pc);
    if (id === B.COHERER_RECEIVER) this._rxCells.add(pc);
    if (id === B.SELENIUM_PANEL) this._selCells.add(pc);
  }

  _indexRemove(pc) {
    const id = this.cells.get(pc);
    if (id === undefined) return;
    this.cells.delete(pc);
    const ck = chunkKey(worldToChunk(qOf(pc)), worldToChunk(rOf(pc)));
    const set = this.byChunk.get(ck);
    if (set) {
      set.delete(pc);
      if (set.size === 0) this.byChunk.delete(ck);
    }
    this._rxCells.delete(pc);
    this._selCells.delete(pc);
    this.rt.delete(pc);
    this._clocks.delete(pc);
    this.burning.delete(pc);
    this._earthCache.delete(pc);
    this._groundCache.delete(pc);
  }

  /** @returns {boolean} the chunk of packed cell pc is loaded (cached per tick) */
  _loaded(pc) {
    const ck = chunkIdOf(pc);
    let v = this._loadedCache.get(ck);
    if (v === undefined) {
      v = Boolean(this.hooks.isLoaded(qOf(pc), rOf(pc)));
      this._loadedCache.set(ck, v);
    }
    return v;
  }

  /** @returns {number} ms from hooks.now (0 without it) */
  _now() {
    return typeof this.hooks.now === 'function' ? this.hooks.now() : 0;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // runtime state

  /** @returns {*} the runtime record of the part at pc (created on demand, reset when the cell's id changed) */
  _rt(pc) {
    const id = this.cells.get(pc);
    let rt = this.rt.get(pc);
    if (rt && rt.id === id) return rt;
    rt = {
      id, closed: false, press: 0, hand: 0, arm: false, armTarget: false, armPending: 0, energised: false, coilKnown: false,
      uncertain: false, tphase: T_IDLE, tleft: 0, pulse: 0, reset: 0, arrive: 0, rxPulse: 0, glow: 0, flash: 0,
      lastSend: -1, lastCount: 0, volts: 0, powered: false, inPowered: false, refire: 0, frozenFeed: false, bright: 0, sel: -1,
      shaded: false, swTick: -100,
    };
    this.rt.set(pc, rt);
    if (id === B.CLOCKWORK_TIMER) {
      const st = this._st(pc);
      if (st && st.on && st.m === 'hold') rt.tphase = T_HOLD;
      else if (st && st.run && st.m === 'repeat') {
        rt.tphase = T_COUNT;
        rt.tleft = this._timerTicks(pc);
        this._clocks.add(pc);
      }
    }
    rt.closed = id !== undefined && this._contactClosed(pc, id, rt);
    return rt;
  }

  /** @returns {PartState|undefined} the store entry of the cell (undefined: defaults) */
  _st(pc) {
    return this.store.get(partKey(qOf(pc), yOf(pc), rOf(pc)));
  }

  /** @returns {number} the input face of a relay, timer or coherer (store `f`, default DEFAULT_INPUT_FACE) */
  _inputFace(pc) {
    const st = this._st(pc);
    return st && Number.isInteger(st.f) ? /** @type {number} */ (st.f) : DEFAULT_INPUT_FACE;
  }

  /** @returns {number} the timer's delay in ticks */
  _timerTicks(pc) {
    const st = this._st(pc);
    const s = st && typeof st.s === 'number' ? st.s : TIMER_DEFAULT_S;
    return ticksOf(s);
  }

  /** @returns {string} the timer's mode */
  _timerMode(pc) {
    const st = this._st(pc);
    return st && st.m ? /** @type {string} */ (st.m) : 'pulse';
  }

  /** @returns {number} channel of a transmitter or receiver */
  _channel(pc) {
    const st = this._st(pc);
    return st && Number.isInteger(st.ch) ? /** @type {number} */ (st.ch) : 1;
  }

  /** Set store fields of the part at pc (null past the cap: the hint then says so). */
  _set(pc, partial) {
    const id = this.cells.get(pc);
    const p = id === undefined ? null : partOf(id);
    if (!p || p.fields.length === 0) return null;
    const st = this.store.set(qOf(pc), yOf(pc), rOf(pc), p.key, partial);
    if (st === null) this._sayOnce('cap', `${TOO_MANY} (${p.key} at ${cellText(pc)} works with its defaults)`);
    return st;
  }

  /** @returns {boolean} a contact's current state (§4.6) */
  _contactClosed(pc, id, rt) {
    const st = this._st(pc);
    switch (id) {
      case B.KNIFE_SWITCH:
        return Boolean(st && st.on);
      case B.PUSH_BUTTON:
        return (rt.press > 0) !== Boolean(st && st.nc);
      case B.RELAY:
        return (rt.arm || rt.hand > 0) !== Boolean(st && st.nc);
      case B.CLOCKWORK_TIMER:
        return rt.tphase === T_PULSE || rt.tphase === T_HOLD || rt.tphase === T_RCLOSED;
      case B.COHERER_RECEIVER:
        return st && st.m === 'latch' ? Boolean(st.on) : rt.rxPulse > 0;
      default:
        return false;
    }
  }

  /** Recompute a contact's state; a change dirties the cell (settle: in the same settling pass). @returns {boolean} changed */
  _refresh(pc, settle = false) {
    const id = this.cells.get(pc);
    if (id === undefined) return false;
    const rt = this._rt(pc);
    const p = partOf(id);
    if (!p || p.role !== 'contact') return false;
    const closed = this._contactClosed(pc, id, rt);
    if (closed === rt.closed) return false;
    rt.closed = closed;
    if (id === B.KNIFE_SWITCH) rt.swTick = this.tickCount;
    this._markDirty(pc, settle);
    return true;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // dirty cells

  /**
   * Mark a cell dirty: its network(s) are rebuilt and its load evaluated in step 5. A battery's change also dirties the
   * batteries stacked on it (their pile voltage and earth follow it). During step 5 a settling mark waits for the next
   * settling pass and any other mark for the next tick (no loops inside a tick).
   */
  _markDirty(pc, settle) {
    const s = Boolean(settle);
    this._mark1(pc, s);
    if (this.cells.get(pc) === B.VOLTAIC_BATTERY) {
      for (let k = 1, a = pc + 1; k <= MAX_PILE && yOf(a) > 0 && this.cells.get(a) === B.VOLTAIC_BATTERY; k++, a++) {
        this._mark1(a, s);
      }
    }
  }

  /**
   * One dirty mark. `_dmark` remembers the build serial at the time of the change: a network built after it already
   * reflects the change, so a burst of dirty cells in one big network (a `fill` of wire) rebuilds it once, not once per cell.
   */
  _mark1(pc, s) {
    this._earthCache.delete(pc);
    this._dmark.set(pc, this._serial);
    if (this._inNetworks) {
      const m = s ? this._settleNext : this._later;
      m.set(pc, (m.get(pc) ?? false) || s);
    } else {
      const had = this._dflag.get(pc);
      if (had === undefined) this._dq.push(pc);
      this._dflag.set(pc, (had ?? false) || s);
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // earth (§4.4)

  /**
   * The column walk of rule 1: from the block below, through at most EARTH_WALK_CELLS placed earth blocks, to a natural
   * earth block or the bottom of the world.
   * @returns {{ ok: boolean, reason: string }}
   */
  _walk(pc) {
    const q = qOf(pc);
    const y = yOf(pc);
    const r = rOf(pc);
    let firstName = '';
    for (let k = 1; k <= EARTH_WALK_CELLS + 1; k++) {
      const yy = y - k;
      if (yy < 0) return { ok: true, reason: '' };
      const id = this.hooks.peek(q, yy, r);
      if (id === UNLOADED) return { ok: false, reason: 'not earthed: the ground below is not loaded' };
      if (!isEarth(id)) {
        if (k > 1) return { ok: false, reason: `not earthed: this ${firstName} is not connected to the ground` };
        return { ok: false, reason: insulatorReason(id) };
      }
      if (k === 1) firstName = nameOf(id).toLowerCase();
      if (!this.hooks.isEdit(q, yy, r)) return { ok: true, reason: '' };
    }
    return { ok: false, reason: `not earthed: this ${firstName} is not connected to the ground` };
  }

  /** @returns {boolean} the earth net of the earth-wire cell pc is grounded (cached per net) */
  _netGrounded(pc) {
    const cached = this._earthNets.get(pc);
    if (cached) return cached.grounded;
    const cells = [pc];
    const seen = new Set(cells);
    let grounded = false;
    for (let i = 0; i < cells.length && cells.length <= MAX_NETWORK_CELLS; i++) {
      const c = cells[i];
      if (!grounded && this._loaded(c) && this._ground(c)) grounded = true;
      for (let f = 0; f < 8; f++) {
        const n = nb(c, f);
        if (n < 0 || seen.has(n) || this.cells.get(n) !== B.EARTH_WIRE) continue;
        seen.add(n);
        cells.push(n);
      }
    }
    const net = { cells, grounded };
    for (const c of cells) this._earthNets.set(c, net);
    return grounded;
  }

  /** @returns {boolean} the earth-wire cell's own walk passes (its ground clamp) */
  _ground(pc) {
    let v = this._groundCache.get(pc);
    if (v === undefined) {
      v = this._loaded(pc) && this._walk(pc).ok;
      this._groundCache.set(pc, v);
    }
    return v;
  }

  /**
   * Forget the earth net through pc (and every clamp in it); every device touching it is dirtied — for SETTLING when a chunk
   * load caused it (a net that becomes grounded by loading must not fire the igniter it earths).
   */
  _invalidateEarthNet(pc, settle = false) {
    this._groundCache.delete(pc);
    const net = this._earthNets.get(pc);
    if (!net) {
      this._dirtyAroundStrap(pc, settle);
      return;
    }
    for (const c of net.cells) {
      this._earthNets.delete(c);
      this._groundCache.delete(c);
      this._dirtyAroundStrap(c, settle);
    }
  }

  /** Dirty every earth-needing device next to an earth-wire cell. */
  _dirtyAroundStrap(c, settle) {
    for (let f = 0; f < 8; f++) {
      const n = nb(c, f);
      const id = n < 0 ? undefined : this.cells.get(n);
      if (id !== undefined && /** @type {*} */ (partOf(id)).earth) this._markDirty(n, settle);
    }
  }

  /**
   * Is the device at pc earthed (§4.4)? Rule 3: a battery in a pile takes its bottom battery's earth. Rule 2: an earth
   * terminal (any face touching an Earth Wire, the bottom included) touches a grounded earth net. Rule 1: the column walk.
   * Cached per device until it is dirtied.
   * @returns {{ ok: boolean, reason: string }}
   */
  _earth(pc) {
    const cached = this._earthCache.get(pc);
    if (cached) return cached;
    let res;
    const id = this.cells.get(pc);
    if (id === B.VOLTAIC_BATTERY && this.cells.get(nb(pc, 7)) === B.VOLTAIC_BATTERY && yOf(pc) > 0) {
      let b = pc - 1;
      for (let k = 0; k < H && yOf(b) > 0 && this.cells.get(b - 1) === B.VOLTAIC_BATTERY; k++) b--;
      res = this._earth(b);
    } else {
      let strap = false;
      res = null;
      for (let f = 0; f < 8; f++) {
        const n = nb(pc, f);
        if (n < 0 || this.cells.get(n) !== B.EARTH_WIRE) continue;
        strap = true;
        if (this._loaded(n) && this._netGrounded(n)) {
          res = { ok: true, reason: '' };
          break;
        }
      }
      if (!res) {
        const w = this._walk(pc);
        res = w.ok || !strap ? w : { ok: false, reason: STRAP_NOT_GROUNDED };
      }
    }
    this._earthCache.set(pc, res);
    return res;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // sources

  /** @returns {{ level: number, list: number[], tall: boolean, height: number }} the pile of the battery at pc, bottom first */
  _pile(pc) {
    const list = [pc];
    let b = pc;
    while (list.length <= MAX_PILE && yOf(b) > 0 && this.cells.get(b - 1) === B.VOLTAIC_BATTERY) {
      b--;
      list.unshift(b);
    }
    let height = list.length;
    for (let a = pc + 1; height <= MAX_PILE + 1 && yOf(a) > 0 && this.cells.get(a) === B.VOLTAIC_BATTERY; a++) height++;
    return { level: list.length, list, tall: list.length > MAX_PILE, height };
  }

  /** @returns {number} a battery's charge in amp-seconds */
  _charge(pc) {
    const st = this._st(pc);
    return st && typeof st.c === 'number' ? st.c : BATTERY_CAPACITY;
  }

  /** @returns {number} the output of the source at pc in units (0: inert), earth not considered */
  _srcUnits(pc, id) {
    if (id === B.VOLTAIC_BATTERY) {
      const pile = this._pile(pc);
      if (pile.tall) return 0;
      let sum = 0;
      for (const b of pile.list) {
        const u = batteryUnits(this._charge(b));
        if (u === 0) return 0;
        sum += u;
      }
      return sum;
    }
    if (id === B.BLASTING_MACHINE) {
      const rt = this.rt.get(pc);
      return rt && rt.id === id && rt.pulse > 0 ? BLASTER_UNITS : 0;
    }
    if (id === B.SELENIUM_PANEL) {
      const rt = this._rt(pc);
      if (rt.sel < 0) this._selenium(pc, rt);
      return rt.sel;
    }
    return 0;
  }

  /** Re-evaluate a selenium panel from daylight and the sky above it. @returns {boolean} its output changed */
  _selenium(pc, rt) {
    const q = qOf(pc);
    const r = rOf(pc);
    let open = true;
    for (let y = yOf(pc) + 1; y < H; y++) {
      const id = this.hooks.peek(q, y, r);
      if (id !== UNLOADED && isOpaque(id)) {
        open = false;
        break;
      }
    }
    const d = typeof this.hooks.daylight === 'function' ? Math.max(0, Math.min(1, Number(this.hooks.daylight()) || 0)) : 0;
    const u = open ? Math.floor((SELENIUM_MAX_V * Math.min(1, Math.max(0, 1.5 * d))) / VOLT_UNIT + 1e-9) : 0;
    const changed = u !== rt.sel || rt.shaded !== !open;
    rt.sel = u;
    rt.shaded = !open;
    return changed;
  }

  /** @returns {number} the output of an earthed, active source (0 otherwise) */
  _activeUnits(pc, id) {
    const u = this._srcUnits(pc, id);
    return u > 0 && this._earth(pc).ok ? u : 0;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // conductors

  /** @returns {boolean} the cell is a conductor now: a signal wire, a terminal board or a closed contact (§4.5) */
  _isConductor(pc, id) {
    const p = partOf(id);
    if (!p) return false;
    if (p.role === 'wire') return p.wire !== 'earth';
    if (p.role === 'junction') return true;
    if (p.role === 'contact') return this._contactClosed(pc, id, this._rt(pc));
    return false;
  }

  /** @returns {number} the input face for conductorAccepts (only contacts with an input have one) */
  _accFace(pc, id) {
    const p = partOf(id);
    return p && p.input ? this._inputFace(pc) : DEFAULT_INPUT_FACE;
  }

  /**
   * The faces a device attaches through (§4.4, §4.5): a source's or load's live faces (0..6 minus faces touching an Earth
   * Wire), an input's single input face. Contacts without an input and everything else: none.
   * @returns {readonly number[]}
   */
  _attachFaces(pc, id) {
    const p = partOf(id);
    if (!p) return [];
    if (p.input) return liveFaces(id, this._inputFace(pc));
    if (p.role === 'source' || p.role === 'load') return liveFaces(id);
    return [];
  }

  /** @returns {boolean} the device at pc is a load or an input (relay coil, timer start, coherer tapper) */
  static _isLoadish(id) {
    const p = partOf(id);
    return Boolean(p && (p.role === 'load' || p.input));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // the tick

  /**
   * Advance by dt seconds: at most 2 ticks; leftover time beyond one tick is dropped (a slow frame plays slower rather than
   * catching up). Nothing runs while switched off.
   */
  step(dt) {
    if (!this.enabled) return;
    if (dt > 0) this._acc += dt;
    let n = 0;
    while (this._acc >= TICK - 1e-9 && n < 2) {
      this._acc -= TICK;
      this.tick();
      n++;
    }
    if (this._acc > TICK) this._acc = TICK;
    if (this._acc < 0) this._acc = 0;
  }

  /** Run one tick now (tests; step() calls it). */
  tick() {
    if (!this.enabled) return;
    this.tickCount++;
    this._loadedCache.clear();
    this._t0 = this._now();
    this._visits = 0;
    this._contactChanges = 0;
    this._stepClocks();
    this._stepFuses();
    this._drainFlameQueue();
    if (this.tickCount % SLOW_EVERY === 0) this._stepSelenium();
    this._stepNetworks();
    this._applyDeferred();
    this._drain();
    if (this.tickCount % SLOW_EVERY === 0) this._unloadCheck();
    this._stepSounds();
    this._stats.visits = this._visits;
    this._stats.ms = this._now() - this._t0;
  }

  /** @returns {boolean} this tick's budget is spent (checked between networks) */
  _overBudget() {
    return this._visits >= MAX_CIRCUIT_VISITS_PER_TICK || this._now() - this._t0 >= CIRCUIT_TICK_BUDGET_MS;
  }

  // ---- 1. clocks

  _stepClocks() {
    for (const pc of [...this._clocks]) {
      const id = this.cells.get(pc);
      const rt = this.rt.get(pc);
      if (id === undefined || !rt || rt.id !== id) {
        this._clocks.delete(pc);
        continue;
      }
      if (!this._loaded(pc)) continue; // frozen with its chunk
      let busy = false;
      if (rt.press > 0) {
        rt.press--;
        if (rt.press === 0) {
          if (this._refresh(pc)) this._sound('buttonClick', pc, 0.6);
        } else busy = true;
      }
      if (rt.hand > 0) {
        rt.hand--;
        if (rt.hand === 0) {
          if (this._refresh(pc)) this._sound('relayClick', pc, 0.4);
        } else busy = true;
      }
      if (rt.armPending > 0) {
        if (rt.armPending === 1 && this._contactChanges >= MAX_CONTACT_CHANGES_PER_TICK) busy = true; // slips a tick
        else {
          rt.armPending--;
          if (rt.armPending === 0) {
            this._contactChanges++;
            rt.arm = rt.armTarget;
            if (this._refresh(pc)) this._relayClicked(pc);
          } else busy = true;
        }
      }
      if (rt.tphase !== T_IDLE && rt.tphase !== T_HOLD) {
        busy = true;
        rt.tleft--;
        if (rt.tleft <= 0) this._timerZero(pc, rt);
      }
      if (rt.pulse > 0) {
        busy = true;
        rt.pulse--;
        if (rt.pulse === 0) {
          rt.reset = BLASTER_RESET_TICKS; // counted from the next tick
          busy = true;
          this._markDirty(pc, false);
        }
      } else if (rt.reset > 0) {
        rt.reset--;
        if (rt.reset > 0) busy = true;
      }
      if (rt.rxPulse > 0) {
        rt.rxPulse--;
        if (rt.rxPulse === 0) this._refresh(pc);
        else busy = true;
      }
      if (rt.refire > 0 && rt.powered) {
        busy = true;
        if (!rt.frozenFeed) {
          rt.refire--;
          if (rt.refire === 0) {
            rt.refire = IGNITER_REFIRE_TICKS;
            this._fire(pc, false);
          }
        }
      }
      if (rt.flash > 0) {
        rt.flash--;
        busy = busy || rt.flash > 0;
      }
      if (rt.glow > 0) {
        rt.glow--;
        busy = busy || rt.glow > 0;
      }
      // Radio arrivals last: the receiver pulse and glow they start are counted from the next tick.
      if (rt.arrive > 0) {
        busy = true;
        if (rt.arrive > 1 || this._contactChanges < MAX_CONTACT_CHANGES_PER_TICK) {
          rt.arrive--;
          if (rt.arrive === 0) {
            this._contactChanges++;
            this._arrive(pc, rt);
          }
        }
      }
      if (!busy) this._clocks.delete(pc);
    }
  }

  /** A running timer's countdown or phase ended. */
  _timerZero(pc, rt) {
    const sTicks = this._timerTicks(pc);
    const mode = this._timerMode(pc);
    if (rt.tphase === T_COUNT) {
      this._sound('timerDing', pc, 0.7);
      if (mode === 'hold') {
        rt.tphase = T_HOLD;
        rt.tleft = 0;
        this._set(pc, { on: true });
      } else if (mode === 'repeat') {
        rt.tphase = T_RCLOSED;
        rt.tleft = repeatClosedTicks(sTicks);
      } else {
        rt.tphase = T_PULSE;
        rt.tleft = TIMER_PULSE_TICKS;
      }
    } else if (rt.tphase === T_PULSE) {
      rt.tphase = T_IDLE;
      rt.tleft = 0;
    } else if (rt.tphase === T_RCLOSED) {
      const open = sTicks - repeatClosedTicks(sTicks);
      if (mode === 'repeat' && open > 0) {
        rt.tphase = T_ROPEN;
        rt.tleft = open;
      } else if (mode === 'repeat') rt.tleft = repeatClosedTicks(sTicks);
      else {
        rt.tphase = T_IDLE;
        rt.tleft = 0;
      }
    } else if (rt.tphase === T_ROPEN) {
      if (mode === 'repeat') {
        rt.tphase = T_RCLOSED;
        rt.tleft = repeatClosedTicks(sTicks);
      } else {
        rt.tphase = T_IDLE;
        rt.tleft = 0;
      }
    }
    this._refresh(pc);
  }

  /** Wind and start a timer (right-click, the R key, `timer … start` or a rising edge on its input). */
  _timerStart(pc) {
    const rt = this._rt(pc);
    const st = this._st(pc);
    if (st && st.on) this._set(pc, { on: false });
    if (this._timerMode(pc) === 'repeat') this._set(pc, { run: true });
    rt.tphase = T_COUNT;
    rt.tleft = this._timerTicks(pc);
    this._clocks.add(pc);
    this._sound('timerWind', pc, 0.6);
    this._refresh(pc);
  }

  /** Stop a timer: idle and open. */
  _timerStop(pc) {
    const rt = this._rt(pc);
    const st = this._st(pc);
    if (st && (st.on || st.run)) this._set(pc, { on: false, run: false });
    rt.tphase = T_IDLE;
    rt.tleft = 0;
    this._refresh(pc);
  }

  /** @returns {boolean} the timer is wound (counting, closed, holding or a running clock) */
  _timerBusy(pc) {
    return this._rt(pc).tphase !== T_IDLE;
  }

  /** A matching radio signal arrives at a receiver (scheduled one tick after the send). */
  _arrive(pc, rt) {
    rt.glow = RX_GLOW_TICKS;
    this._clocks.add(pc);
    const st = this._st(pc);
    if (st && st.m === 'latch') {
      if (!st.on) this._set(pc, { on: true });
    } else rt.rxPulse = RADIO_PULSE_TICKS;
    this._refresh(pc);
  }

  /** Tap a coherer: the filings fall apart and it opens (the R key, or a rising edge on its tapper). */
  _tap(pc) {
    const rt = this._rt(pc);
    const st = this._st(pc);
    if (st && st.m === 'latch' && st.on) this._set(pc, { on: false });
    rt.rxPulse = 0;
    this._refresh(pc);
  }

  _relayClicked(pc) {
    if (this._relayClickTick === this.tickCount) return;
    this._relayClickTick = this.tickCount;
    this._sound('relayClick', pc, 0.2);
  }

  // ---- 2. fuses

  /**
   * Light the fuse cell at pc, the flame coming in by face `from` (−1 = lit in place). Refused for a spent or burning cell;
   * a cell in an unloaded chunk, or one beyond MAX_BURNING_FUSES, waits in the flame queue.
   * @returns {boolean} it started burning, or waits in the flame queue to (false: refused)
   */
  _lightFuse(pc, from, src = -1) {
    if (this.burning.has(pc) || this.spent.has(pc) || this.cells.get(pc) !== B.POWDER_FUSE) return false;
    if (!this._loaded(pc) || this.burning.size >= MAX_BURNING_FUSES) {
      this._enqueueFlame(pc, from, src);
      return this._flameSet.has(pc);
    }
    this.burning.set(pc, { ticks: FUSE_TICKS, total: FUSE_TICKS, from, start: this.tickCount });
    return true;
  }

  _stepFuses() {
    if (this.burning.size === 0) return;
    /** @type {number[]} */
    const done = [];
    for (const [pc, b] of this.burning) {
      if (b.start === this.tickCount || !this._loaded(pc)) continue;
      b.ticks--;
      if (b.ticks <= 0) done.push(pc);
    }
    for (const pc of done) this._finishFuse(pc);
    // Sparks from the nearest burning cells, a hiss every 0.4 s at the nearest one.
    if (this.burning.size > 0) {
      const near = this._nearest(this.burning.keys(), MAX_FUSE_SPARK_CELLS);
      for (const pc of near) this._particles('sparks', pc, 1, 0.05, { spread: 0.05, speed: 0.4 });
      if (this.tickCount % HISS_TICKS === 0 && near.length > 0) this._sound('fuseHiss', near[0], 0.5);
    }
  }

  /** A burning cell's time is up: it is spent (AIR written later) and lights every fuse, keg and charge beside it. */
  _finishFuse(pc) {
    this.burning.delete(pc);
    if (this.cells.get(pc) !== B.POWDER_FUSE) return; // cut
    this.spent.add(pc);
    this._writeQ.push(pc);
    for (let f = 0; f < 8; f++) {
      const n = nb(pc, f);
      if (n < 0) continue;
      const id = this.cells.get(n);
      if (id === B.POWDER_FUSE) this._lightFuse(n, FACE_OPPOSITE[f], pc);
      else if (id === B.POWDER_KEG) this._ignite(n, 'keg', FACE_OPPOSITE[f], pc);
      else if (id === B.COLLAPSAR_CHARGE) this._ignite(n, 'charge', FACE_OPPOSITE[f], pc);
    }
  }

  /** Queue a deferred ignition of the keg, charge or fuse at pc, lit from the cell `src` (step 6 dispatches it). */
  _ignite(pc, kind, from, src) {
    this._ignQ.push({ pc, kind, from, src, srcId: src >= 0 ? this.cells.get(src) ?? -1 : -1 });
  }

  // ---- 3. the flame queue

  _enqueueFlame(pc, from, src) {
    if (this._flameSet.has(pc) || this._flameQ.length >= MAX_FLAME_QUEUE) return;
    this._flameSet.add(pc);
    this._flameQ.push({ pc, from, src });
  }

  /** Queue the flame-rule candidates around a cell whose id is now `id` (§4.3). CAMPFIRE + POWDER_KEG is explosions'. */
  _queueFlameFor(pc, id) {
    if (isFlame(id)) {
      for (let f = 0; f < 8; f++) {
        const n = nb(pc, f);
        const nid = n < 0 ? undefined : this.cells.get(n);
        if (nid === undefined || !isIgnitable(nid)) continue;
        if (id === B.CAMPFIRE && nid === B.POWDER_KEG) continue;
        this._enqueueFlame(n, FACE_OPPOSITE[f], pc);
      }
    } else if (isIgnitable(id)) {
      for (let f = 0; f < 8; f++) {
        const n = nb(pc, f);
        const nid = n < 0 ? undefined : this.cells.get(n);
        if (nid === undefined || !isFlame(nid)) continue;
        if (nid === B.CAMPFIRE && id === B.POWDER_KEG) continue;
        this._enqueueFlame(pc, f, n);
        return;
      }
    }
  }

  /** Every indexed ignitable with a flame beside it (load, stream-in, switching on). */
  _queueAllFlames() {
    for (const [pc, id] of this.cells) if (isIgnitable(id)) this._queueFlameFor(pc, id);
  }

  _drainFlameQueue() {
    const n = this._flameQ.length;
    if (n === 0) return;
    const items = this._flameQ.splice(0, n);
    for (const it of items) this._flameSet.delete(it.pc);
    for (const it of items) {
      const id = this.cells.get(it.pc);
      if (id === undefined) continue;
      if (!this._loaded(it.pc)) {
        this._enqueueFlame(it.pc, it.from, it.src); // parks until its chunk loads (stream-in re-queues it too)
        continue;
      }
      if (id === B.POWDER_FUSE) this._lightFuse(it.pc, it.from, it.src);
      else if (id === B.POWDER_KEG) this._ignite(it.pc, 'keg', it.from, it.src);
      else if (id === B.COLLAPSAR_CHARGE) this._ignite(it.pc, 'charge', it.from, it.src);
    }
  }

  // ---- 4. selenium

  _stepSelenium() {
    for (const pc of this._selCells) {
      if (!this._loaded(pc)) continue;
      if (this._selenium(pc, this._rt(pc))) this._markDirty(pc, false);
    }
  }

  // ---- 5. networks

  _stepNetworks() {
    this._inNetworks = true;
    try {
      this._pass(this._dq, this._dflag, true);
      for (let pass = 1; pass < MAX_SETTLE_PASSES && this._settleNext.size > 0 && !this._overBudget(); pass++) {
        const q = [...this._settleNext.keys()];
        const flags = new Map(this._settleNext);
        this._settleNext.clear();
        this._pass(q, flags, false);
      }
    } finally {
      this._inNetworks = false;
    }
    // Whatever waits (settling marks past the pass limit, edges' changes) is solved next tick.
    for (const [pc, s] of this._settleNext) this._markDirty(pc, s);
    for (const [pc, s] of this._later) this._markDirty(pc, s);
    this._settleNext.clear();
    this._later.clear();
  }

  /**
   * One build pass: rebuild every network touched by the dirty cells of `queue` (the main FIFO keeps what the budget leaves),
   * then evaluate the loads on them.
   * @param {number[]} queue
   * @param {Map<number, boolean>} flags
   * @param {boolean} main  `queue` is the persistent FIFO (budget leftovers stay in it)
   */
  _pass(queue, flags, main) {
    const serial = ++this._serial;
    this._passSerial = serial;
    let head = main ? this._dqHead : 0;
    while (true) {
      if (this._seedHead < this._seeds.length) {
        const s = this._seeds[this._seedHead];
        const settle = this._seedSettle[this._seedHead];
        const mark = this._seedMark[this._seedHead];
        const net = this.nodeNet.get(s);
        const fresh = net !== undefined && net.alive && net.serial > mark;
        const id = fresh ? 0 : this.cells.get(s);
        if (!fresh && (id === undefined || !this._isConductor(s, id))) {
          if (net && !net.alive) this.nodeNet.delete(s);
          else if (net && net.alive) this._retire(net, settle);
          this._seedHead++;
          continue;
        }
        if (fresh) {
          // Built after the change this seed stands for: it already reflects it. A settling seed still keeps its loads
          // from taking edges when the network was built in this very pass.
          if (settle && !net.settle && net.serial === serial) {
            net.settle = true;
            for (const l of net.loads) this._evalSet.set(l, true);
          }
          this._seedHead++;
          continue;
        }
        if (!this._loaded(s)) {
          this._seedHead++; // its chunk is away: its network stays as it was, and onChunkLoaded dirties it again
          continue;
        }
        if (this._overBudget()) break;
        this._seedHead++;
        this._build(s, settle, serial);
        continue;
      }
      this._seeds.length = 0;
      this._seedSettle.length = 0;
      this._seedMark.length = 0;
      this._seedHead = 0;
      if (head >= queue.length) break;
      if (main && this._overBudget()) break;
      const pc = queue[head++];
      const settle = flags.get(pc) ?? false;
      if (main) flags.delete(pc);
      this._expand(pc, settle);
    }
    if (main) {
      this._dqHead = head;
      if (head >= queue.length) {
        queue.length = 0;
        this._dqHead = 0;
      } else if (head > 4096 && head * 2 > queue.length) {
        queue.splice(0, head);
        this._dqHead = 0;
      }
    }
    const evals = this._evalSet;
    this._evalSet = new Map();
    for (const [pc, settle] of evals) this._evaluate(pc, settle);
  }

  /** A dirty cell: seed the rebuild of every network it may change, and evaluate it when it is a load. */
  _expand(pc, settle) {
    const id = this.cells.get(pc);
    const mark = this._dmark.get(pc) ?? -1;
    this._dmark.delete(pc);
    const old = this.nodeNet.get(pc);
    if (old && old.alive) {
      if (!(old.serial > mark)) this._retire(old, settle);
    } else if (old) this.nodeNet.delete(pc);
    if (id !== undefined) {
      if (id === B.SELENIUM_PANEL) this._selenium(pc, this._rt(pc));
      if (this._isConductor(pc, id)) this._seed(pc, settle, mark);
      if (Circuits._isLoadish(id)) this._evalSet.set(pc, (this._evalSet.get(pc) ?? false) || settle);
    }
    for (let f = 0; f < 8; f++) {
      const n = nb(pc, f);
      if (n < 0) continue;
      const nid = this.cells.get(n);
      if (nid === undefined) continue;
      if (this._isConductor(n, nid)) this._seed(n, settle, mark);
      else if (Circuits._isLoadish(nid)) this._evalSet.set(n, (this._evalSet.get(n) ?? false) || settle);
    }
  }

  /** Queue a BFS seed; it is skipped when its network was built after `mark` (the build serial of the change). */
  _seed(pc, settle, mark) {
    this._seeds.push(pc);
    this._seedSettle.push(settle);
    this._seedMark.push(mark);
  }

  /** A network is gone: its nodes are re-seeded (a split or merge rebuilds them) and its loads re-evaluated. */
  _retire(net, settle) {
    if (!net.alive) return;
    net.alive = false;
    this.networks.delete(net);
    const mark = this._serial - 1; // rebuilt unless a network of this pass already took them
    for (const n of net.nodes) if (this.nodeNet.get(n) === net) this._seed(n, settle, mark);
    for (const l of net.loads) this._evalSet.set(l, (this._evalSet.get(l) ?? false) || settle);
  }

  /**
   * BFS one network from the conductor s (§4.7 "The solver"): neighbours through the index; an unloaded cell ends a branch and
   * marks the network partial; at most MAX_NETWORK_CELLS nodes; then attachments, I_net, and the volts by Dial's algorithm.
   */
  _build(s, settle, serial) {
    /** @type {Net} */
    const net = {
      id: ++this._netId, serial, alive: true, nodes: [s], idx: new Map([[s, 0]]), units: new Int16Array(0),
      seg: new Int32Array(0), sources: [], srcUnits: [], maxSrc: 0, loads: [], amps: 0, w: 0, partial: false,
      truncated: false, frozen: false, settle, chunks: new Set(),
    };
    const nodes = net.nodes;
    const idx = net.idx;
    const cells = this.cells;
    /** @type {number[]} adjacency as (from, to) node-index pairs, both directions */
    const edges = [];
    /** @type {number[]} union-find parents over the wire / board edges (§4.5 segments) */
    const parent = [0];
    /** @type {Map<number, number>} attached source → its index in net.sources */
    const srcIndex = new Map();
    /** @type {Set<number>} */
    const loadSeen = new Set();
    /** @type {number[]} source attachments as (source index, node index) pairs */
    const seeds = [];
    let tainted = false;
    const find = (i) => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    for (let head = 0; head < nodes.length; head++) {
      const pc = nodes[head];
      const id = /** @type {number} */ (cells.get(pc));
      this._visits++;
      // The node's own cell and chunk, once: a neighbour inside the same chunk needs no loaded check.
      const y = pc % H;
      const col = (pc - y) / H;
      const rr = col % SPAN;
      const q = (col - rr) / SPAN - OFF;
      const r = rr - OFF;
      const cq = Math.floor(q / CHUNK_SIZE);
      const cr = Math.floor(r / CHUNK_SIZE);
      const lq = q - cq * CHUNK_SIZE;
      const lr = r - cr * CHUNK_SIZE;
      net.chunks.add((cq + 65536) * 131072 + (cr + 65536));
      const kindA = KIND[id];
      const segA = kindA === K_WIRE || kindA === K_JUNCTION;
      const sigA = SIG[id];
      const inA = INPUT[id] ? this._inputFace(pc) : -1;
      if (id === B.RELAY && this.rt.get(pc)?.uncertain) tainted = true;
      for (let f = 0; f < 8; f++) {
        if (f === inA) continue; // a contact's input face is never a contact terminal: no edge, no attachment
        let n;
        let same = true;
        if (f === 6) {
          if (y === H - 1) continue;
          n = pc + 1;
        } else if (f === 7) {
          if (y === 0) continue;
          n = pc - 1;
        } else {
          n = pc + NB[f];
          const nq = lq + DQ[f];
          const nr = lr + DR[f];
          same = nq >= 0 && nq < CHUNK_SIZE && nr >= 0 && nr < CHUNK_SIZE;
        }
        const nid = cells.get(n);
        if (nid === undefined) continue;
        if (!same && !this._loaded(n)) {
          net.partial = true;
          continue;
        }
        const kindB = KIND[nid];
        const g = FACE_OPPOSITE[f];
        if (kindB === K_WIRE || kindB === K_JUNCTION || kindB === K_CONTACT) {
          const sigB = SIG[nid];
          const inB = INPUT[nid] ? this._inputFace(n) : -1;
          const joins = g !== inB && (sigA === 0 || sigB === 0 || sigA === sigB)
            && (kindB !== K_CONTACT || this._contactClosed(n, nid, this._rt(n)));
          if (joins) {
            let j = idx.get(n);
            if (j === undefined) {
              // A node another network of this pass took, or one of a live TRUNCATED network, is a boundary: only a
              // too-large circuit can meet one, and its cells past the cap stay apart (they read 0 V) instead of fighting
              // over the cap.
              const other = this.nodeNet.get(n);
              if (other && other.alive && other !== net && (other.serial === serial || other.truncated)) continue;
              if (nodes.length >= MAX_NETWORK_CELLS) {
                net.truncated = true;
                continue;
              }
              j = nodes.length;
              nodes.push(n);
              idx.set(n, j);
              parent.push(j);
            }
            edges.push(head, j);
            if (segA && (kindB === K_WIRE || kindB === K_JUNCTION)) {
              const a = find(head);
              const b = find(j);
              if (a !== b) parent[a] = b;
            }
            continue;
          }
          // A relay whose coil cannot be known yet taints the networks on its contact faces (not its input face).
          if (nid === B.RELAY && g !== inB && this.rt.get(n)?.uncertain) tainted = true;
          if (!(INPUT[nid] && g === inB)) continue;
          // … else: this face is the contact's input: a load (relay coil, timer start, tapper), below.
        }
        if (kindB === K_SOURCE) {
          if (g > 6) continue; // a source's bottom is its earth terminal
          let si = srcIndex.get(n);
          if (si === undefined) {
            const u = this._activeUnits(n, nid);
            if (u <= 0) continue;
            si = net.sources.length;
            srcIndex.set(n, si);
            net.sources.push(n);
            net.srcUnits.push(u);
            if (u > net.maxSrc) net.maxSrc = u;
            net.chunks.add(chunkIdOf(n));
          }
          seeds.push(si, head);
        } else if (kindB === K_LOAD || INPUT[nid]) {
          if (g > 6 || (INPUT[nid] && g !== this._inputFace(n))) continue;
          if (loadSeen.has(n) || !this._earth(n).ok) continue;
          loadSeen.add(n);
          net.loads.push(n);
          net.amps += AMPS[nid];
          net.chunks.add(chunkIdOf(n));
        }
      }
    }
    const count = nodes.length;
    net.seg = new Int32Array(count);
    for (let i = 0; i < count; i++) net.seg[i] = nodes[find(i)];
    net.w = Math.ceil(net.amps - 1e-9) * UNITS_PER_AMP;
    const u = new Int16Array(count);
    if (net.partial) {
      for (let i = 0; i < count; i++) u[i] = this._unitsOf(nodes[i]); // frozen: the last solved voltages
    } else if (net.maxSrc > 0) {
      // Adjacency in CSR form, then Dial's bucket queue from the highest source voltage down.
      const start = new Int32Array(count + 1);
      for (let k = 0; k < edges.length; k += 2) start[edges[k] + 1]++;
      for (let i = 0; i < count; i++) start[i + 1] += start[i];
      const adj = new Int32Array(edges.length / 2);
      const fill = start.slice(0, count);
      for (let k = 0; k < edges.length; k += 2) adj[fill[edges[k]]++] = edges[k + 1];
      const isWire = new Uint8Array(count);
      for (let i = 0; i < count; i++) isWire[i] = KIND[/** @type {number} */ (cells.get(nodes[i]))] === K_WIRE ? 1 : 0;
      const w = net.w;
      /** @type {number[][]} */
      const buckets = new Array(net.maxSrc + 1);
      for (let k = 0; k < seeds.length; k += 2) {
        const i = seeds[k + 1];
        const v = net.srcUnits[seeds[k]] - (isWire[i] ? w : 0);
        if (v > u[i]) {
          u[i] = v;
          (buckets[v] ??= []).push(i);
        }
      }
      for (let v = net.maxSrc; v > 0; v--) {
        const b = buckets[v];
        if (!b) continue;
        while (b.length > 0) {
          const i = /** @type {number} */ (b.pop());
          if (u[i] !== v) continue;
          for (let e = start[i]; e < start[i + 1]; e++) {
            const j = adj[e];
            const nv = v - (isWire[j] ? w : 0);
            if (nv > u[j]) {
              u[j] = nv;
              if (nv > 0) (buckets[nv] ??= []).push(j);
            }
          }
        }
      }
    }
    net.units = u;
    net.frozen = net.partial || tainted;
    for (const n of nodes) {
      const old = this.nodeNet.get(n);
      if (old !== undefined && old !== net && old.alive) this._retire(old, settle);
      this.nodeNet.set(n, net);
    }
    this.networks.add(net);
    for (const l of net.loads) this._evalSet.set(l, (this._evalSet.get(l) ?? false) || settle || net.frozen);
    if (net.truncated) {
      let said = false;
      for (const n of nodes) if (this._truncSaid.has(n)) said = true;
      if (!said) {
        for (const n of nodes) this._truncSaid.add(n);
        this._say(TRUNCATED);
      }
    }
    return net;
  }

  /** @returns {number} the solved units of a conductor node (0 when it is in no network) */
  _unitsOf(pc) {
    const net = this.nodeNet.get(pc);
    if (!net) return 0;
    const i = net.idx.get(pc);
    return i === undefined || i >= net.units.length ? 0 : net.units[i];
  }

  /**
   * The live voltage at a load or input: the highest node it attaches to (0 when not earthed).
   * @returns {{ units: number, frozen: boolean, settle: boolean, nets: Net[] }}
   */
  _loadFeed(pc, id) {
    const out = { units: 0, frozen: false, settle: false, nets: /** @type {Net[]} */ ([]) };
    if (!this._earth(pc).ok) return out;
    for (const g of this._attachFaces(pc, id)) {
      const n = nb(pc, g);
      if (n < 0) continue;
      const nid = this.cells.get(n);
      if (nid === undefined || !this._loaded(n)) continue;
      const net = this.nodeNet.get(n);
      if (!net || !this._isConductor(n, nid) || !conductorAccepts(nid, FACE_OPPOSITE[g], this._accFace(n, nid))) continue;
      const v = this._unitsOf(n);
      if (v > out.units) out.units = v;
      if (net.frozen) out.frozen = true;
      if (net.settle && net.serial === this._passSerial) out.settle = true;
      if (!out.nets.includes(net)) out.nets.push(net);
    }
    return out;
  }

  /**
   * Evaluate a load or input after its networks were solved, and take its EDGE actions unless settling or frozen (§4.6,
   * §4.7 step 5).
   */
  _evaluate(pc, settle) {
    const id = this.cells.get(pc);
    if (id === undefined || !Circuits._isLoadish(id)) return;
    const p = /** @type {*} */ (partOf(id));
    const rt = this._rt(pc);
    const feed = this._loadFeed(pc, id);
    const noEdges = settle || feed.frozen || feed.settle;
    const powered = feed.units > 0 && feed.units >= units(p.vMin ?? 0);
    rt.volts = feed.units;
    rt.frozenFeed = feed.frozen;
    switch (id) {
      case B.FILAMENT_LAMP:
        rt.powered = powered && feed.units >= LAMP_MIN_UNITS;
        rt.bright = rt.powered ? Math.max(0, Math.min(1, (feed.units * VOLT_UNIT - LAMP_MIN_V) / (LAMP_FULL_V - LAMP_MIN_V))) : 0;
        break;
      case B.ELECTRIC_BELL:
        rt.powered = powered;
        break;
      case B.IGNITER: {
        const rising = powered && !rt.powered;
        rt.powered = powered;
        if (!powered) rt.refire = 0;
        else if (rising) {
          rt.refire = IGNITER_REFIRE_TICKS; // the refire clock starts from 0, settling or not
          this._clocks.add(pc);
          if (!noEdges) this._fire(pc, true);
        }
        break;
      }
      case B.SPARK_TRANSMITTER: {
        const rising = powered && !rt.powered;
        rt.powered = powered;
        if (rising && !noEdges) this._send(pc);
        break;
      }
      case B.RELAY:
        this._evalRelay(pc, rt, powered, settle || feed.settle, feed);
        break;
      case B.CLOCKWORK_TIMER: {
        const rising = powered && !rt.inPowered;
        rt.inPowered = powered;
        if (rising && !noEdges) {
          const ph = rt.tphase;
          if (ph === T_IDLE || ph === T_PULSE) this._timerStart(pc);
        }
        break;
      }
      case B.COHERER_RECEIVER: {
        const rising = powered && !rt.inPowered;
        rt.inPowered = powered;
        if (rising && !noEdges) this._tap(pc);
        break;
      }
      default:
        rt.powered = powered;
    }
  }

  /** A relay coil (§4.6): its contacts follow RELAY_DELAY_TICKS later, or at once while settling. */
  _evalRelay(pc, rt, powered, settle, feed) {
    const inN = nb(pc, this._inputFace(pc));
    const inUnloaded = inN >= 0 && this.cells.has(inN) && !this._loaded(inN);
    let uncertain = false;
    if (feed.frozen || inUnloaded) {
      uncertain = !rt.coilKnown; // keeps its last state; unknown when it never had one
    } else {
      rt.coilKnown = true;
      rt.inPowered = powered;
      if (powered !== rt.energised) {
        rt.energised = powered;
        if (settle) {
          rt.arm = powered;
          rt.armPending = 0;
          this._refresh(pc, true);
        } else if (rt.arm !== powered || rt.armPending > 0) {
          rt.armTarget = powered;
          rt.armPending = rt.arm === powered ? 0 : RELAY_DELAY_TICKS;
          if (rt.armPending > 0) this._clocks.add(pc);
        }
      } else if (settle && rt.arm !== powered) {
        rt.arm = powered;
        rt.armPending = 0;
        this._refresh(pc, true);
      }
    }
    if (uncertain !== rt.uncertain) {
      rt.uncertain = uncertain;
      this._markDirty(pc, true);
    }
  }

  /** An igniter fires: every fuse, keg and charge beside it is lit (deferred to step 6). */
  _fire(pc, first) {
    for (let f = 0; f < 8; f++) {
      const n = nb(pc, f);
      if (n < 0) continue;
      const id = this.cells.get(n);
      if (id === B.POWDER_FUSE) this._ignite(n, 'fuse', FACE_OPPOSITE[f], pc);
      else if (id === B.POWDER_KEG) this._ignite(n, 'keg', FACE_OPPOSITE[f], pc);
      else if (id === B.COLLAPSAR_CHARGE) this._ignite(n, 'charge', FACE_OPPOSITE[f], pc);
    }
    if (first) this._sound('igniterPop', pc, 0.7);
  }

  /** A transmitter sends on its wavelength (at most once per tick): the flash, the zap and the receivers next tick. */
  _send(pc) {
    const rt = this._rt(pc);
    if (rt.lastSend === this.tickCount) return rt.lastCount;
    rt.lastSend = this.tickCount;
    rt.flash = TX_FLASH_TICKS;
    this._clocks.add(pc);
    this._sound('sparkZap', pc, 0.8);
    rt.lastCount = this._broadcast(this._channel(pc), xOf(pc), yOf(pc) + 0.5, zOf(pc));
    return rt.lastCount;
  }

  /** @returns {number} receivers on channel `ch` within RADIO_RANGE of (x, y, z) in loaded chunks; each closes next tick */
  _broadcast(ch, x, y, z) {
    let n = 0;
    const r2 = RADIO_RANGE * RADIO_RANGE;
    for (const pc of this._rxCells) {
      if (this._channel(pc) !== ch || !this._loaded(pc)) continue;
      const dx = xOf(pc) - x;
      const dy = yOf(pc) + 0.5 - y;
      const dz = zOf(pc) - z;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      const rt = this._rt(pc);
      rt.arrive = 1;
      this._clocks.add(pc);
      n++;
    }
    return n;
  }

  // ---- 6. deferred effects

  _applyDeferred() {
    let writes = 0;
    let puffs = 0;
    const wq = this._writeQ;
    let i = 0;
    /** @type {number[]} */
    const keep = [];
    for (; i < wq.length && writes < MAX_CIRCUIT_WRITES_PER_TICK; i++) {
      const pc = wq[i];
      if (!this.spent.has(pc) || this.cells.get(pc) !== B.POWDER_FUSE) {
        this.spent.delete(pc);
        continue;
      }
      if (!this._loaded(pc)) {
        keep.push(pc);
        continue;
      }
      writes++;
      const ok = this.hooks.setBlock(qOf(pc), yOf(pc), rOf(pc), B.AIR);
      if (!ok) this.spent.delete(pc);
      else if (puffs < MAX_FUSE_PUFFS_PER_TICK) {
        puffs++;
        this._particles('smoke', pc, 3, 0.1, { spread: 0.15, speed: 0.4 });
        this._particles('sparks', pc, 2, 0.1, { spread: 0.1, speed: 0.6 });
      }
    }
    this._writeQ = keep.concat(wq.slice(i));
    let fired = 0;
    const iq = this._ignQ;
    let k = 0;
    /** @type {typeof iq} */
    const wait = [];
    for (; k < iq.length && fired < MAX_IGNITIONS_PER_TICK; k++) {
      const it = iq[k];
      const id = this.cells.get(it.pc);
      const want = it.kind === 'fuse' ? B.POWDER_FUSE : it.kind === 'keg' ? B.POWDER_KEG : B.COLLAPSAR_CHARGE;
      if (id !== want) continue;
      if (!this._loaded(it.pc)) {
        wait.push(it);
        continue;
      }
      fired++;
      if (it.kind === 'fuse') {
        this._lightFuse(it.pc, it.from, it.src);
        continue;
      }
      const hook = it.kind === 'keg' ? this.hooks.igniteKeg : this.hooks.activateCharge;
      const res = typeof hook === 'function' ? hook(qOf(it.pc), yOf(it.pc), rOf(it.pc)) : null;
      if (res && !res.ok && !res.quiet) this._refused(it, res.message);
    }
    this._ignQ = wait.concat(iq.slice(k));
  }

  /** An ignition was refused (explosions or black holes off): one chat line per cause per 4 s. */
  _refused(it, message) {
    const m = String(message ?? '');
    const cause = /^explosions are off/.test(m) ? 'explosions are off' : /^black holes are off/.test(m) ? 'black holes are off' : m;
    const srcId = it.srcId >= 0 ? it.srcId : undefined;
    const what = srcId === undefined ? 'flame' : srcId === B.POWDER_FUSE ? 'fuse' : nameOf(srcId).toLowerCase();
    const where = it.src >= 0 ? ` at ${cellText(it.src)}` : '';
    this._sayOnce(`refused:${cause}`, `the ${what}${where} has nothing to light: ${cause}`);
  }

  // ---- 7. drain

  _drain() {
    /** @type {Map<number, number>} battery → amp-seconds to take this tick */
    const take = new Map();
    for (const net of this.networks) {
      if (net.frozen || net.amps <= 0 || net.sources.length === 0) continue;
      const paying = [];
      for (let i = 0; i < net.sources.length; i++) if (net.srcUnits[i] === net.maxSrc) paying.push(net.sources[i]);
      const share = (net.amps * TICK) / paying.length;
      for (const s of paying) {
        if (this.cells.get(s) !== B.VOLTAIC_BATTERY) continue; // selenium and the blasting machine never drain
        for (const b of this._pile(s).list) if (this._loaded(b)) take.set(b, (take.get(b) ?? 0) + share);
      }
    }
    for (const [b, amount] of take) {
      const c = this._charge(b);
      const before = batteryUnits(c);
      const next = Math.max(0, c - amount);
      if (!this.store.setCharge(qOf(b), yOf(b), rOf(b), next)) continue;
      if (batteryUnits(next) !== before) this._markDirty(b, false);
    }
  }

  // ---- 8. the unload check

  _unloadCheck() {
    for (const net of this.networks) {
      if (net.frozen) continue;
      for (const ck of net.chunks) {
        const [cq, cr] = chunkOfId(ck);
        if (!this.hooks.isLoaded(cq * CHUNK_SIZE, cr * CHUNK_SIZE)) {
          net.frozen = true;
          break;
        }
      }
    }
  }

  // ---- sounds that repeat

  _stepSounds() {
    // The nearest ringing bell strikes every 0.12 s; the nearest running timer ticks every 0.5 s.
    this._bellAcc += TICK;
    if (this._bellAcc >= BELL_STRIKE_S) {
      this._bellAcc -= BELL_STRIKE_S;
      const bell = this._nearestWhere((pc, id, rt) => id === B.ELECTRIC_BELL && rt && rt.powered, BELL_RANGE);
      if (bell >= 0) this._sound('bellRing', bell, 0.6);
    }
    if (this.tickCount % TIMER_TICK_TICKS === 0) {
      const t = this._nearestWhere((pc, id, rt) => id === B.CLOCKWORK_TIMER && rt && rt.tphase === T_COUNT, TIMER_TICK_RANGE);
      if (t >= 0) this._sound('timerTick', t, 0.3);
    }
  }

  /** @returns {number} the nearest runtime cell (to the last overlays eye) for which `test` holds, within `range`; −1 none */
  _nearestWhere(test, range) {
    let best = -1;
    let bestD = range * range;
    for (const [pc, rt] of this.rt) {
      if (!test(pc, rt.id, rt)) continue;
      if (!this._eye) return pc;
      const d = this._dist2(pc, this._eye[0], this._eye[1], this._eye[2]);
      if (d <= bestD) {
        bestD = d;
        best = pc;
      }
    }
    return best;
  }

  /** @returns {number[]} up to n of the cells, nearest the last overlays eye first (any n of them without an eye) */
  _nearest(cells, n) {
    const list = [...cells];
    if (list.length <= n && !this._eye) return list;
    if (!this._eye) return list.slice(0, n);
    const [x, y, z] = this._eye;
    list.sort((a, b) => this._dist2(a, x, y, z) - this._dist2(b, x, y, z));
    return list.slice(0, n);
  }

  _dist2(pc, x, y, z) {
    const dx = xOf(pc) - x;
    const dy = yOf(pc) + 0.5 - y;
    const dz = zOf(pc) - z;
    return dx * dx + dy * dy + dz * dz;
  }

  _sound(name, pc, volume = 1) {
    if (typeof this.hooks.sound === 'function') this.hooks.sound(name, xOf(pc), yOf(pc) + 0.5, zOf(pc), volume);
  }

  _particles(kind, pc, count, dy, opts) {
    if (typeof this.hooks.particles === 'function') this.hooks.particles(kind, xOf(pc), yOf(pc) + dy, zOf(pc), count, opts);
  }

  _say(text) {
    if (typeof this.hooks.say === 'function') this.hooks.say(text);
  }

  /** Say `text` at most once per 4 s per `cause`. */
  _sayOnce(cause, text) {
    const last = this._said.get(cause);
    if (last !== undefined && this.tickCount - last < SAY_GAP_TICKS) return;
    this._said.set(cause, this.tickCount);
    this._say(text);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // the player's hands (§4.9)

  /**
   * Operate the part at a cell: `'use'` (right-click) works controls only; `'r'` (the R key) also pushes a relay's armature,
   * taps a coherer and lights a fuse. Null when the cell has no such action (main falls through to the next R-key step or
   * places a block).
   * @param {'r'|'use'} via
   * @returns {{ ok: boolean, message?: string, channel?: number }|null}
   */
  interact(q, y, r, via) {
    if (!(y >= 0 && y < H)) return null;
    const pc = packCell(q, y, r);
    const id = this.cells.get(pc);
    if (id === undefined || !isPart(id)) return null;
    const p = /** @type {*} */ (partOf(id));
    const rOnly = id === B.RELAY || id === B.COHERER_RECEIVER || id === B.POWDER_FUSE;
    if (via === 'use' ? !p.control : via !== 'r' || !(p.control || rOnly)) return null;
    this._loadedCache.clear();
    if (!this._loaded(pc)) return null;
    if (!this.enabled) return { ok: false, message: CIRCUITS_OFF };
    const rt = this._rt(pc);
    switch (id) {
      case B.KNIFE_SWITCH: {
        const st = this._set(pc, { on: !this._contactClosed(pc, id, rt) });
        if (!st) return { ok: false, message: TOO_MANY };
        this._refresh(pc);
        this._sound('switchClack', pc, 0.8);
        return { ok: true, message: '' };
      }
      case B.PUSH_BUTTON:
        this._press(pc, rt, BUTTON_PULSE_TICKS);
        return { ok: true, message: '' };
      case B.CLOCKWORK_TIMER:
        if (this._timerBusy(pc)) this._timerStop(pc);
        else this._timerStart(pc);
        return { ok: true, message: '' };
      case B.SPARK_TRANSMITTER: {
        const ch = this._channel(pc);
        const n = this._send(pc);
        return { ok: true, message: sentText(ch, n), channel: ch };
      }
      case B.BLASTING_MACHINE:
        if (rt.pulse > 0 || rt.reset > 0) return { ok: false, message: 'the handle is still rising' };
        rt.pulse = BLASTER_PULSE_TICKS + 1; // +1 as for a button press
        this._clocks.add(pc);
        this._markDirty(pc, false);
        this._sound('plunger', pc, 0.9);
        return { ok: true, message: '' };
      case B.RELAY:
        rt.hand = Math.max(rt.hand, RELAY_HAND_TICKS + 1);
        this._clocks.add(pc);
        if (this._refresh(pc)) this._relayClicked(pc);
        return { ok: true, message: '' };
      case B.COHERER_RECEIVER:
        this._tap(pc);
        return { ok: true, message: '' };
      case B.POWDER_FUSE:
        if (this.burning.has(pc) || this.spent.has(pc)) return { ok: false, message: 'the fuse is already burning' };
        if (!this._lightFuse(pc, -1)) return { ok: false, message: 'the fuse could not be lit' };
        this._sound('fuseLight', pc, 0.7);
        return { ok: true, message: '' };
      default:
        return null;
    }
  }

  _press(pc, rt, ticks) {
    const was = rt.press > 0;
    rt.press = Math.max(rt.press, ticks + 1); // +1: the next tick's clock step counts the first tick down at once
    this._clocks.add(pc);
    this._refresh(pc);
    if (!was) this._sound('buttonClick', pc, 0.6);
  }

  /**
   * Keep a held control pressed (main, every frame the operating button or the R key stays held on the same cell): a Push
   * Button releases BUTTON_RELEASE_S after the last call; a Relay's armature stays pushed.
   */
  hold(q, y, r) {
    if (!this.enabled || !(y >= 0 && y < H)) return;
    const pc = packCell(q, y, r);
    const id = this.cells.get(pc);
    if (id === B.PUSH_BUTTON) this._press(pc, this._rt(pc), BUTTON_RELEASE_TICKS);
    else if (id === B.RELAY) {
      const rt = this._rt(pc);
      rt.hand = Math.max(rt.hand, BUTTON_RELEASE_TICKS + 1);
      this._clocks.add(pc);
      if (this._refresh(pc)) this._relayClicked(pc);
    }
  }

  /** The pocket key (§4.6): send on channel `ch` from the player. */
  pocketSend(ch, x, y, z) {
    return this.radio(ch, x, y, z);
  }

  /**
   * `radio <channel>` and the pocket key: every receiver on that wavelength within RADIO_RANGE closes on the next tick.
   * @param {number|string} ch  a channel 1..16 or a token parseChannel reads ('400m')
   * @returns {{ ok: boolean, message: string }}
   */
  radio(ch, x, y, z) {
    const c = typeof ch === 'number' ? parseChannel(ch) : parseChannel(String(ch));
    if (c === null) return { ok: false, message: `expected a channel 1–16 or a wavelength 300m–1050m, got "${ch}"` };
    if (!this.enabled) return { ok: false, message: CIRCUITS_OFF };
    this._loadedCache.clear();
    const n = this._broadcast(c, x, y, z);
    return { ok: true, message: sentText(c, n) };
  }

  /**
   * `ignite q y r` (and Survival's hand-lighting): a fuse lights in place, a keg burns in place for BARREL_FUSE_S (3 s)
   * through hooks.igniteKeg, a charge is set off through hooks.activateCharge.
   * @returns {{ ok: boolean, message: string }}
   */
  ignite(q, y, r) {
    const at = `(${q}, ${y}, ${r})`;
    if (!(y >= 0 && y < H)) return { ok: false, message: `there is nothing to light at ${at} — a powder keg, powder fuse or collapsar charge` };
    this._loadedCache.clear();
    const id = this.hooks.peek(q, y, r);
    if (id === UNLOADED) return { ok: false, message: `cell ${at} is not loaded` };
    const pc = packCell(q, y, r);
    if (id === B.POWDER_FUSE) {
      if (!this.enabled) return { ok: false, message: CIRCUITS_OFF };
      if (this.burning.has(pc) || this.spent.has(pc)) return { ok: false, message: `the fuse at ${at} is already burning` };
      if (!this.cells.has(pc)) this._indexAdd(pc, id);
      if (!this._lightFuse(pc, -1)) return { ok: false, message: `the fuse at ${at} could not be lit` };
      this._sound('fuseLight', pc, 0.7);
      return { ok: true, message: `lit the powder fuse at ${at}` };
    }
    if (id === B.POWDER_KEG) {
      if (typeof this.hooks.igniteKeg !== 'function') return { ok: false, message: 'block physics is not available here' };
      const res = this.hooks.igniteKeg(q, y, r, BARREL_FUSE_S);
      return { ok: Boolean(res && res.ok), message: String(res?.message ?? '') };
    }
    if (id === B.COLLAPSAR_CHARGE) {
      if (typeof this.hooks.activateCharge !== 'function') return { ok: false, message: 'black holes are not available here' };
      const res = this.hooks.activateCharge(q, y, r);
      return { ok: Boolean(res && res.ok), message: String(res?.message ?? '') };
    }
    return { ok: false, message: `there is nothing to light at ${at} — a powder keg, powder fuse or collapsar charge` };
  }

  /**
   * Would a keg or fuse restored at (q, y, r) catch at once (blockphysics' undo, §3.6)? A flame (campfire, torch) or a
   * powered igniter among its 8 neighbours.
   * @returns {boolean}
   */
  wouldIgnite(q, y, r) {
    if (!(y >= 0 && y < H)) return false;
    const pc = packCell(q, y, r);
    for (let f = 0; f < 8; f++) {
      const n = nb(pc, f);
      if (n < 0) continue;
      const id = this.cells.get(n);
      if (id === undefined) continue;
      if (isFlame(id)) return true;
      if (id === B.IGNITER) {
        // CONTRACT-ISSUE (integrator): undo restores the igniter and its wires just before the kegs, so their networks are
        // still dirty and the restored igniter has no runtime state yet: solve the waiting cells now, SETTLING (no edge
        // fires), so "powered" is what the next tick would find (§3.6: the quarry on a battery and a closed switch).
        if (this._dq.length > this._dqHead) this._settleNow();
        const rt = this.rt.get(n);
        if (rt && rt.id === id && rt.powered) return true;
      }
    }
    return false;
  }

  /**
   * Solve every waiting dirty cell now, as settling (loads take their state with no edge actions): wouldIgnite's look-ahead
   * after a burst of restored cells. A no-op inside a tick's network step or while switched off.
   */
  _settleNow() {
    if (this._inNetworks || !this.enabled) return;
    for (const pc of this._dflag.keys()) this._dflag.set(pc, true);
    this._loadedCache.clear();
    this._t0 = this._now();
    this._visits = 0;
    this._stepNetworks();
  }

  /**
   * `switch q y r [on|off|toggle|press]`: a Knife Switch is set, opened or toggled ('press' toggles it too); a Push Button is
   * pressed for BUTTON_PULSE_S ('toggle' presses it).
   * @returns {{ ok: boolean, message: string }}
   */
  switchAt(q, y, r, mode = 'toggle') {
    const at = `(${q}, ${y}, ${r})`;
    const pc = y >= 0 && y < H ? packCell(q, y, r) : -1;
    const id = pc < 0 ? undefined : this.cells.get(pc);
    if (id !== B.KNIFE_SWITCH && id !== B.PUSH_BUTTON) return { ok: false, message: `there is no switch or button at ${at}` };
    this._loadedCache.clear();
    if (!this._loaded(pc)) return { ok: false, message: `cell ${at} is not loaded` };
    if (!this.enabled) return { ok: false, message: CIRCUITS_OFF };
    const rt = this._rt(pc);
    if (id === B.PUSH_BUTTON) {
      if (mode === 'on' || mode === 'off') return { ok: false, message: `the push button at ${at} can only be pressed` };
      this._press(pc, rt, BUTTON_PULSE_TICKS);
      return { ok: true, message: `push button at ${at}: pressed` };
    }
    const closed = this._contactClosed(pc, id, rt);
    const on = mode === 'on' ? true : mode === 'off' ? false : !closed;
    if (on !== closed) {
      if (!this._set(pc, { on })) return { ok: false, message: TOO_MANY };
      this._refresh(pc);
      this._sound('switchClack', pc, 0.8);
    }
    return { ok: true, message: `knife switch at ${at}: ${on ? 'closed' : 'open'}` };
  }

  /**
   * `timer q y r [start|stop|<seconds>] [pulse|hold|repeat]`: no command → its status; start / stop; seconds → the delay
   * (clamped to TIMER_MIN_S..TIMER_MAX_S in 0.5 s steps); a mode sets the mode too.
   * @param {string|number|null|undefined} cmd
   * @param {string} [mode]
   * @returns {{ ok: boolean, message: string }}
   */
  timerAt(q, y, r, cmd, mode) {
    const at = `(${q}, ${y}, ${r})`;
    const pc = y >= 0 && y < H ? packCell(q, y, r) : -1;
    if (pc < 0 || this.cells.get(pc) !== B.CLOCKWORK_TIMER) return { ok: false, message: `there is no clockwork timer at ${at}` };
    this._loadedCache.clear();
    if (!this._loaded(pc)) return { ok: false, message: `cell ${at} is not loaded` };
    let c = cmd;
    let m = mode;
    if (typeof c === 'string' && ['pulse', 'hold', 'repeat'].includes(c.toLowerCase()) && m === undefined) {
      m = c.toLowerCase();
      c = undefined;
    }
    if (m !== undefined && m !== null) {
      if (!['pulse', 'hold', 'repeat'].includes(String(m))) return { ok: false, message: `expected pulse, hold or repeat, got "${m}"` };
      if (!this._set(pc, { m })) return { ok: false, message: TOO_MANY };
      this._reconcileTimer(pc);
    }
    if (c === undefined || c === null || c === '') return { ok: true, message: `timer at ${at}: ${this._timerStatus(pc)}` };
    const word = typeof c === 'string' ? c.toLowerCase() : c;
    if (word === 'start' || word === 'stop') {
      if (!this.enabled) return { ok: false, message: CIRCUITS_OFF };
      if (word === 'start') this._timerStart(pc);
      else this._timerStop(pc);
      return { ok: true, message: word === 'start' ? `timer at ${at} started: ${this._timerSetting(pc)}` : `timer at ${at} stopped` };
    }
    const s = typeof word === 'number' ? word : /^(\d+(\.\d*)?|\.\d+)$/.test(String(word)) ? Number(word) : NaN;
    if (!Number.isFinite(s)) return { ok: false, message: `expected start, stop or a delay in seconds, got "${c}"` };
    const st = this._set(pc, { s });
    if (!st) return { ok: false, message: TOO_MANY };
    const clamped = st.s !== s;
    return { ok: true, message: `timer at ${at}: ${this._timerSetting(pc)}${clamped ? ' (clamped)' : ''}` };
  }

  /** A timer's mode changed under it: drop a hold latch or a repeat that no longer applies. */
  _reconcileTimer(pc) {
    const st = this._st(pc);
    const rt = this._rt(pc);
    if (!st) return;
    if (st.m !== 'hold' && st.on) {
      this._set(pc, { on: false });
      if (rt.tphase === T_HOLD) rt.tphase = T_IDLE;
    }
    if (st.m !== 'repeat' && st.run) this._set(pc, { run: false });
    if (st.m === 'repeat' && rt.tphase !== T_IDLE && !st.run) this._set(pc, { run: true });
    this._refresh(pc);
  }

  /** "10 s pulse" */
  _timerSetting(pc) {
    const st = this._st(pc);
    return `${formatSeconds(st && typeof st.s === 'number' ? st.s : TIMER_DEFAULT_S)} ${this._timerMode(pc)}`;
  }

  /** "10 s pulse, 7.2 s left" / ", idle" / ", closed" / "holding" / ", running" */
  _timerStatus(pc) {
    const rt = this._rt(pc);
    if (rt.tphase === T_HOLD) return `${this._timerSetting(pc)}, holding`;
    if (rt.tphase === T_COUNT) return `${this._timerSetting(pc)}, ${formatSeconds(rt.tleft * TICK)} left`;
    if (rt.tphase === T_PULSE) return `${this._timerSetting(pc)}, closed`;
    if (rt.tphase === T_RCLOSED || rt.tphase === T_ROPEN) return `${this._timerSetting(pc)}, running`;
    return `${this._timerSetting(pc)}, idle`;
  }

  /** Set the input face of a relay, timer or coherer (main: at placement, from inputFaceFromYaw; the device panel: 0..6). */
  setInputFace(q, y, r, face) {
    if (!(y >= 0 && y < H)) return null;
    const pc = packCell(q, y, r);
    const id = this.cells.get(pc);
    if (id === undefined || !partOf(id)?.input) return null;
    const st = this._set(pc, { f: face });
    this._markDirty(pc, false);
    this.geometryVersion++;
    return st;
  }

  /**
   * The device panel's changes, validated through normalizePart (§4.10). The part reacts at once: a switch opens or closes,
   * a timer's hold or repeat that no longer applies is dropped, an input face is moved.
   * @param {Record<string, *>} partial
   * @returns {PartState|null}
   */
  applySettings(q, y, r, partial) {
    if (!(y >= 0 && y < H) || !partial || typeof partial !== 'object') return null;
    const pc = packCell(q, y, r);
    const id = this.cells.get(pc);
    if (id === undefined || !isPart(id)) return null;
    const before = this._inputFace(pc);
    const st = this._set(pc, partial);
    if (!st) return null;
    if (id === B.CLOCKWORK_TIMER) this._reconcileTimer(pc);
    if (id === B.VOLTAIC_BATTERY) this._markDirty(pc, false);
    this._refresh(pc);
    if (this._inputFace(pc) !== before) {
      this._markDirty(pc, false);
      this.geometryVersion++;
    }
    return st;
  }

  /** Creative's Refill: the battery at the cell is full again. @returns {boolean} */
  refill(q, y, r) {
    if (!(y >= 0 && y < H)) return false;
    const pc = packCell(q, y, r);
    if (this.cells.get(pc) !== B.VOLTAIC_BATTERY) return false;
    this.store.setCharge(q, y, r, BATTERY_CAPACITY);
    this._markDirty(pc, false);
    return true;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // reading it: hints, the multimeter, the panel, overlays

  /**
   * @returns {{ volts: number, amps: number, earthed: boolean|null, earthReason: string, state: string,
   *   diag: 'bypassed'|'self-fed'|'no-wire'|null, net: { cells: number, sources: number, loads: number, partial: boolean,
   *   truncated: boolean }|null }|null} the multimeter reading of a part (§6.5 `volts`); null for anything else
   */
  probe(q, y, r) {
    if (!(y >= 0 && y < H)) return null;
    const pc = packCell(q, y, r);
    const id = this.cells.get(pc);
    if (id === undefined || !isPart(id)) return null;
    const p = /** @type {*} */ (partOf(id));
    const rt = this._rt(pc);
    let u = 0;
    let amps = 0;
    /** @type {Net|null} */
    let net = null;
    if (this.nodeNet.has(pc) && this._isConductor(pc, id)) {
      net = /** @type {Net} */ (this.nodeNet.get(pc));
      u = this._unitsOf(pc);
      amps = net.amps;
    } else if (p.role === 'source') {
      u = this._activeUnits(pc, id);
      for (const n of this.networks) if (n.sources.includes(pc)) amps += n.amps;
    } else if (Circuits._isLoadish(id)) {
      const feed = this._loadFeed(pc, id);
      u = feed.units;
      amps = p.amps ?? 0;
      for (const n of feed.nets) if (!net || this._netTop(n) > this._netTop(net)) net = n;
    } else if (p.role === 'contact') {
      for (const f of [0, 1, 2, 3, 4, 5, 6, 7]) {
        const n = nb(pc, f);
        if (n >= 0 && this.nodeNet.has(n)) u = Math.max(u, this._unitsOf(n));
      }
    }
    const needsEarth = Boolean(p.earth);
    const e = needsEarth ? this._earth(pc) : null;
    let earthed = needsEarth ? Boolean(e && e.ok) : null;
    if (id === B.EARTH_WIRE) earthed = this._netGrounded(pc);
    return {
      volts: u * VOLT_UNIT,
      amps,
      earthed,
      earthReason: e && !e.ok ? e.reason : '',
      state: this._state(pc, id, rt),
      diag: this._diag(pc, id),
      net: net ? { cells: net.nodes.length, sources: net.sources.length, loads: net.loads.length, partial: net.partial, truncated: net.truncated } : null,
    };
  }

  /** @returns {number} the highest node voltage of a network */
  _netTop(net) {
    let m = 0;
    for (let i = 0; i < net.units.length; i++) if (net.units[i] > m) m = net.units[i];
    return m;
  }

  /** @returns {string} a one-word state for probe() and the panel */
  _state(pc, id, rt) {
    switch (id) {
      case B.FILAMENT_LAMP:
        return rt.powered ? 'lit' : 'dark';
      case B.ELECTRIC_BELL:
        return rt.powered ? 'ringing' : 'silent';
      case B.IGNITER:
        return rt.powered ? 'hot' : 'cold';
      case B.SPARK_TRANSMITTER:
        return rt.flash > 0 ? 'sending' : 'ready';
      case B.RELAY:
        return `${rt.energised ? 'energised' : 'released'}, contacts ${this._contactClosed(pc, id, rt) ? 'closed' : 'open'}`;
      case B.CLOCKWORK_TIMER:
        return ['idle', 'running', 'closed', 'holding', 'running', 'running'][rt.tphase];
      case B.KNIFE_SWITCH:
      case B.PUSH_BUTTON:
      case B.COHERER_RECEIVER:
        return this._contactClosed(pc, id, rt) ? 'closed' : 'open';
      case B.VOLTAIC_BATTERY:
        return this._charge(pc) > 0 ? `${Math.floor((this._charge(pc) / BATTERY_CAPACITY) * 100)} %` : 'flat';
      case B.BLASTING_MACHINE:
        return rt.pulse > 0 ? 'firing' : rt.reset > 0 ? 'rising' : 'ready';
      case B.SELENIUM_PANEL:
        return rt.shaded ? 'shaded' : this._srcUnits(pc, id) > 0 ? 'lit' : 'dark';
      case B.POWDER_FUSE:
        return this.burning.has(pc) ? 'burning' : this.spent.has(pc) ? 'spent' : 'unlit';
      case B.TORCH:
        return 'burning';
      case B.POWDER_KEG:
        return typeof this.hooks.kegBurning === 'function' && this.hooks.kegBurning(qOf(pc), yOf(pc), rOf(pc)) ? 'burning' : 'unlit';
      case B.COLLAPSAR_CHARGE:
        return typeof this.hooks.chargeArming === 'function' && this.hooks.chargeArming(qOf(pc), yOf(pc), rOf(pc)) ? 'collapsing' : 'dormant';
      case B.EARTH_WIRE:
        return this._netGrounded(pc) ? 'grounded' : 'not grounded';
      default:
        return this._unitsOf(pc) > 0 ? 'live' : 'dead';
    }
  }

  /**
   * The §4.5 diagnostics: a bypassed open contact, a relay or coherer fed by its own battery, a load set against a source
   * with no conductor. @returns {'bypassed'|'self-fed'|'no-wire'|null}
   */
  _diag(pc, id) {
    const p = partOf(id);
    if (!p) return null;
    const rt = this._rt(pc);
    if ((id === B.RELAY || id === B.COHERER_RECEIVER) && this._selfFed(pc)) return 'self-fed';
    if (p.role === 'contact' && !this._contactClosed(pc, id, rt) && this._bypassed(pc, id)) return 'bypassed';
    if (p.role === 'load' || p.input) {
      let conductor = false;
      let source = false;
      for (const g of this._attachFaces(pc, id)) {
        const n = nb(pc, g);
        const nid = n < 0 ? undefined : this.cells.get(n);
        if (nid === undefined) continue;
        if (conductorAccepts(nid, FACE_OPPOSITE[g], this._accFace(n, nid)) && this._isConductor(n, nid)) conductor = true;
      }
      for (let f = 0; f < 8; f++) {
        const n = nb(pc, f);
        const nid = n < 0 ? undefined : this.cells.get(n);
        if (nid !== undefined && partOf(nid)?.role === 'source') source = true;
      }
      if (!conductor && source) return 'no-wire';
    }
    return null;
  }

  /** @returns {boolean} an open contact whose terminals all collapse into one segment (§4.5 "Bypassed contact") */
  _bypassed(pc, id) {
    const input = partOf(id)?.input ? this._inputFace(pc) : -1;
    /** @type {Set<string>} */
    const groups = new Set();
    /** @type {Set<number>} segments of the conductors it touches */
    const segs = new Set();
    /** @type {number[]} devices it touches */
    const devices = [];
    let terminals = 0;
    for (let f = 0; f < 8; f++) {
      if (f === input) continue;
      const n = nb(pc, f);
      const nid = n < 0 ? undefined : this.cells.get(n);
      if (nid === undefined) continue;
      const np = /** @type {*} */ (partOf(nid));
      if (this._isConductor(n, nid)) {
        // The contact would join it if it were closed: a contact accepts every face but its input, any wire kind.
        if (!conductorAccepts(nid, FACE_OPPOSITE[f], this._accFace(n, nid))) continue;
        const net = this.nodeNet.get(n);
        const i = net ? net.idx.get(n) : undefined;
        const seg = net && i !== undefined && i < net.seg.length ? net.seg[i] : n;
        segs.add(seg);
        terminals++;
      } else if (np.role === 'source' || np.role === 'load' || np.input) {
        const faces = this._attachFaces(n, nid);
        if (faces.includes(FACE_OPPOSITE[f])) {
          devices.push(n);
          terminals++;
        }
      }
    }
    if (terminals < 2) return false;
    for (const s of segs) groups.add(`s${s}`);
    for (const d of devices) {
      // A device that also attaches directly to one of those segments joins it.
      let joined = null;
      const did = /** @type {number} */ (this.cells.get(d));
      for (const g of this._attachFaces(d, did)) {
        const n = nb(d, g);
        const nid = n < 0 ? undefined : this.cells.get(n);
        if (nid === undefined || n === pc || !this._isConductor(n, nid)) continue;
        const net = this.nodeNet.get(n);
        const i = net ? net.idx.get(n) : undefined;
        const seg = net && i !== undefined && i < net.seg.length ? net.seg[i] : n;
        if (segs.has(seg)) joined = seg;
      }
      groups.add(joined !== null ? `s${joined}` : `d${d}`);
    }
    return groups.size <= 1;
  }

  /** @returns {boolean} a source on the relay's (or coherer's) input network also touches one of its contact faces */
  _selfFed(pc) {
    const input = this._inputFace(pc);
    const n = nb(pc, input);
    const net = n < 0 ? undefined : this.nodeNet.get(n);
    if (!net || !net.alive) return false;
    for (let f = 0; f < 8; f++) {
      if (f === input) continue;
      const s = nb(pc, f);
      if (s >= 0 && net.sources.includes(s)) return true;
    }
    return false;
  }

  /**
   * The crosshair hint for a part (§4.9), or null for anything that is not one (and for the Powder Keg, whose hints are
   * main's, §3.3, and the Campfire).
   * @returns {string|null}
   */
  hintFor(q, y, r) {
    if (!(y >= 0 && y < H)) return null;
    const pc = packCell(q, y, r);
    const id = this.cells.get(pc);
    if (id === undefined || !isPart(id) || id === B.POWDER_KEG) return null;
    const p = /** @type {*} */ (partOf(id));
    const st = this._st(pc);
    const rt = this._rt(pc);
    const label = st && st.l ? `${st.l} · ` : '';
    const name = nameOf(id);
    const head = `${label}${name}`;
    const e = p.earth ? this._earth(pc) : null;
    const diag = this._diag(pc, id);
    if (diag === 'self-fed') return `${head} · ${SELF_FED}`;
    if (diag === 'bypassed') return `${head} · ${BYPASSED}`;
    switch (id) {
      case B.COPPER_WIRE:
      case B.BROWN_WIRE:
      case B.WHITE_WIRE:
        return `${head} · ${formatVolts(this._unitsOf(pc))}`;
      case B.EARTH_WIRE:
        return this._netGrounded(pc) ? `${head} · grounded` : `${head} · not grounded: run it down to soil or stone`;
      case B.TERMINAL_BOARD:
        return `${head} · joins every wire colour · ${formatVolts(this._unitsOf(pc))}`;
      case B.VOLTAIC_BATTERY: {
        const pile = this._pile(pc);
        if (pile.tall) return `${head} · pile too tall (${MAX_PILE} at most)`;
        if (e && !e.ok) return `${head} · ${e.reason}`;
        const c = this._charge(pc);
        if (!(c > 0)) return `${head} · flat`;
        const pct = Math.floor((c / BATTERY_CAPACITY) * 100);
        const tired = c < BATTERY_KNEE * BATTERY_CAPACITY ? ' (tired)' : '';
        const pileText = pile.height > 1 ? ` · pile of ${Math.min(pile.height, MAX_PILE)}` : '';
        const u = this._srcUnits(pc, id);
        if (u === 0) return `${head}${pileText} · 0 V: a battery below it is flat`;
        return `${head}${pileText} · ${formatVolts(u)} · ${pct} %${tired}`;
      }
      case B.BLASTING_MACHINE:
        if (e && !e.ok) return `${head} · ${e.reason}`;
        if (rt.pulse > 0) return `${head} · ${BLASTER_V} V`;
        if (rt.reset > 0) return `${head} · handle rising…`;
        return `${head} · right-click: push the plunger (${BLASTER_V} V for ${BLASTER_PULSE_S} s)`;
      case B.SELENIUM_PANEL: {
        if (e && !e.ok) return `${head} · ${e.reason}`;
        const u = this._srcUnits(pc, id);
        if (rt.shaded) return `${head} · shaded: it needs open sky`;
        return u > 0 ? `${head} · ${formatVolts(u)} in daylight` : `${head} · dark`;
      }
      case B.KNIFE_SWITCH:
        return this._contactClosed(pc, id, rt) ? `${head} · closed · right-click: open it` : `${head} · open · right-click: close it`;
      case B.PUSH_BUTTON:
        return st && st.nc ? `${label}${name} (NC) · hold right-click to open` : `${head} · hold right-click to press`;
      case B.CLOCKWORK_TIMER: {
        if (e && !e.ok && this._inputFed(pc)) return `${head} · ${e.reason}`;
        if (rt.tphase === T_HOLD) return `${head} · holding · right-click: reset`;
        if (rt.tphase === T_COUNT) return `${head} · ${formatSeconds(rt.tleft * TICK)} left · right-click: stop`;
        if (rt.tphase === T_PULSE) return `${head} · closed · right-click: stop`;
        if (rt.tphase === T_RCLOSED || rt.tphase === T_ROPEN) return `${head} · ${this._timerSetting(pc)} · running · right-click: stop`;
        return `${head} · ${this._timerSetting(pc)} · right-click: wind and start · Shift+R key: set`;
      }
      case B.RELAY: {
        if (e && !e.ok) return `${head} · ${e.reason}`;
        const closed = this._contactClosed(pc, id, rt);
        const coil = this._loadFeed(pc, id).units;
        return `${head} · coil ${formatVolts(coil)} · contacts ${closed ? 'closed' : 'open'} (${st && st.nc ? 'NC' : 'NO'}) · R key: push armature · Shift+R key: settings`;
      }
      case B.IGNITER:
      case B.FILAMENT_LAMP:
      case B.ELECTRIC_BELL: {
        if (e && !e.ok) return `${head} · ${e.reason}`;
        if (diag === 'no-wire') return `${head} · ${NO_WIRE}`;
        const u = this._loadFeed(pc, id).units;
        if (id === B.IGNITER) return rt.powered ? `${head} · ${formatVolts(u)} · hot!` : `${head} · ${formatVolts(u)} (fires at ${p.vMin} V)`;
        if (id === B.FILAMENT_LAMP) return rt.powered ? `${head} · ${formatVolts(u)} · lit` : `${head} · ${formatVolts(u)} (needs ${p.vMin} V)`;
        if (rt.powered) return `${head} · ringing`;
        return u > 0 ? `${head} · ${formatVolts(u)} (needs ${p.vMin} V)` : `${head} · 0 V`;
      }
      case B.SPARK_TRANSMITTER:
        return `${head} · ${wavelengthText(this._channel(pc))} · right-click: send · Shift+R key: wavelength`;
      case B.COHERER_RECEIVER: {
        const m = st && st.m === 'latch' ? 'latch' : 'pulse';
        const closed = this._contactClosed(pc, id, rt) ? ' · closed' : '';
        return `${head} · ${wavelengthText(this._channel(pc))} · ${m}${closed} · R key: tap · Shift+R key: settings`;
      }
      case B.POWDER_FUSE:
        return this.burning.has(pc) || this.spent.has(pc) ? `${head} · burning · left-click: cut it` : `${head} · R key: light it here`;
      case B.TORCH:
        return `${head} · always burning: lights fuses, kegs and charges beside it`;
      case B.COLLAPSAR_CHARGE:
        return this._state(pc, id, rt) === 'collapsing' ? `${head} · collapsing!` : `${head} · dormant · set it off from afar: fuse, igniter or radio`;
      default:
        return head;
    }
  }

  /** @returns {boolean} something conducts on the timer's input face (its start input is in use) */
  _inputFed(pc) {
    const n = nb(pc, this._inputFace(pc));
    const nid = n < 0 ? undefined : this.cells.get(n);
    return nid !== undefined && this._isConductor(n, nid);
  }

  /**
   * What the device panel shows for a part (§4.10, §6.2.15), or null when the cell holds none.
   * @param {boolean} creative  Refill is offered in Creative only
   * @returns {DevicePanelView|null}
   */
  panelView(q, y, r, creative) {
    const pr = this.probe(q, y, r);
    if (!pr) return null;
    const pc = packCell(q, y, r);
    const id = /** @type {number} */ (this.cells.get(pc));
    const p = /** @type {*} */ (partOf(id));
    const st = this._st(pc);
    const rt = this._rt(pc);
    /** @type {string[]} */
    const readout = [];
    const thin = p.role === 'wire' || p.role === 'fuse' || p.role === 'flame';
    if (p.role !== 'fuse' && p.role !== 'flame' && p.role !== 'ignitable') readout.push(`Volts: ${formatVolts(units(pr.volts))}`);
    if (pr.net) readout.push(`Current: ${pr.net ? Math.round(pr.amps * 100) / 100 : 0} A on ${pr.net.cells} cells`);
    if (pr.earthed !== null && id !== B.EARTH_WIRE) readout.push(pr.earthed ? 'Earthed: yes' : `Earthed: no — ${pr.earthReason.replace(/^not earthed: /, '')}`);
    if (pr.diag === 'bypassed') readout.push(`Bypassed: ${BYPASSED.replace(/^bypassed: /, '')}`);
    else if (pr.diag === 'self-fed') readout.push(`Self-fed: ${SELF_FED}`);
    else if (pr.diag === 'no-wire') readout.push(NO_WIRE);
    if (id === B.VOLTAIC_BATTERY) {
      readout.push(`Charge: ${Math.floor((this._charge(pc) / BATTERY_CAPACITY) * 100)} % (${formatVolts(batteryUnits(this._charge(pc)))})`);
    } else readout.push(`State: ${pr.state}`);
    /** @type {DevicePanelView['fields']} */
    const fields = {};
    if (!thin && st) for (const f of ['s', 'm', 'f', 'nc', 'ch', 'on', 'c']) if (p.fields.includes(f)) fields[f] = st[f];
    /** @type {DevicePanelView['actions']} */
    const actions = [];
    if (id === B.CLOCKWORK_TIMER) actions.push(rt.tphase === T_IDLE ? 'start' : 'stop');
    else if (id === B.SPARK_TRANSMITTER) actions.push('send');
    else if (id === B.COHERER_RECEIVER) actions.push('tap');
    else if (id === B.VOLTAIC_BATTERY && creative) actions.push('refill');
    return {
      key: partKey(q, y, r), k: p.key, id, title: nameOf(id), coords: `(${q}, ${y}, ${r})`, label: st && st.l ? st.l : '',
      readout, fields, actions, origin: partOrigin(id), about: partTip(id),
    };
  }

  /**
   * The moving and lit bits to draw this frame (§4.11), nearest first, at most MAX_CIRCUIT_OVERLAYS within `range` of the eye.
   * The eye is also remembered for the nearest-first sounds and sparks. Per type (a, b), as circuitGeometry.overlayPose reads
   * them (CONTRACTS §53): blade (closed 0/1, seconds since it last moved), cap (pressed 0/1, NC 0/1), hand (time left / delay,
   * holding 0/1), arm (energised or pushed 0/1, NC 0/1), plunger (travel 0 cocked … 1 pushed home, 0), hammer (ringing 0/1,
   * seed), bulb (brightness, 0), glow (intensity, see `glow`: lamp b = brightness, fuse b = the from face, −1 lit in place,
   * or FUSE_AT_BUNG 8 on a keg burning in place; charge / ember b = seed), staff (torch: seed, 0; filament: brightness, 0;
   * char: burnt fraction, from face).
   * The integrator aligned these with circuitGeometry's header (blade, cap, plunger and the keg's bung were the other way).
   * @param {OverlayItem[]} [out]
   * @returns {OverlayItem[]}
   */
  overlays(x, y, z, range, out = []) {
    out.length = 0;
    this._eye = [x, y, z];
    const near = this._cellsNear(x, y, z, range, (id) => id !== B.CAMPFIRE && this._hasOverlay(id));
    for (const pc of near) {
      if (out.length >= MAX_CIRCUIT_OVERLAYS) break;
      this._overlaysOf(pc, /** @type {number} */ (this.cells.get(pc)), out);
    }
    if (out.length > MAX_CIRCUIT_OVERLAYS) out.length = MAX_CIRCUIT_OVERLAYS;
    return out;
  }

  /** @returns {boolean} the part may draw an overlay */
  _hasOverlay(id) {
    return id !== B.COPPER_WIRE && id !== B.BROWN_WIRE && id !== B.WHITE_WIRE && id !== B.EARTH_WIRE && id !== B.TERMINAL_BOARD
      && id !== B.VOLTAIC_BATTERY && id !== B.SELENIUM_PANEL;
  }

  _overlaysOf(pc, id, out) {
    const q = qOf(pc);
    const y = yOf(pc);
    const r = rOf(pc);
    const item = (type, a, b, extra) => out.push(/** @type {OverlayItem} */ ({ type, q, y, r, a, b, ...extra }));
    const rt = this.rt.get(pc)?.id === id ? this.rt.get(pc) : this._rt(pc);
    const st = this._st(pc);
    switch (id) {
      case B.KNIFE_SWITCH:
        item('blade', this._contactClosed(pc, id, rt) ? 1 : 0, Math.min(1, (this.tickCount - rt.swTick) * TICK));
        break;
      case B.PUSH_BUTTON:
        item('cap', rt.press > 0 ? 1 : 0, st && st.nc ? 1 : 0);
        break;
      case B.CLOCKWORK_TIMER: {
        const total = this._timerTicks(pc);
        item('hand', rt.tphase === T_COUNT ? Math.max(0, Math.min(1, rt.tleft / total)) : 0, rt.tphase === T_HOLD ? 1 : 0);
        break;
      }
      case B.RELAY:
        item('arm', rt.arm || rt.hand > 0 ? 1 : 0, st && st.nc ? 1 : 0);
        break;
      case B.BLASTING_MACHINE:
        item('plunger', rt.pulse > 0 ? 1 : rt.reset > 0 ? rt.reset / BLASTER_RESET_TICKS : 0, 0);
        break;
      case B.ELECTRIC_BELL:
        item('hammer', rt.powered ? 1 : 0, seedOf(pc));
        break;
      case B.FILAMENT_LAMP:
        item('bulb', rt.bright, 0);
        item('staff', rt.bright, 0, { staff: 'filament' });
        if (rt.bright > 0) item('glow', rt.bright, rt.bright, { glow: 'lamp' });
        break;
      case B.IGNITER:
        if (rt.powered) item('glow', 1, 0, { glow: 'igniter' });
        break;
      case B.TORCH:
        item('staff', seedOf(pc), 0, { staff: 'torch' });
        item('glow', 1, seedOf(pc), { glow: 'ember' });
        break;
      case B.SPARK_TRANSMITTER:
        if (rt.flash > 0) item('glow', rt.flash / TX_FLASH_TICKS, 0, { glow: 'spark' });
        break;
      case B.COHERER_RECEIVER:
        if (rt.glow > 0) item('glow', rt.glow / RX_GLOW_TICKS, 0, { glow: 'coherer' });
        break;
      case B.COLLAPSAR_CHARGE:
        item('glow', 1, seedOf(pc), { glow: 'charge' });
        break;
      case B.POWDER_FUSE: {
        const b = this.burning.get(pc);
        if (b) {
          const frac = 1 - b.ticks / b.total;
          item('glow', frac, b.from, { glow: 'fuse' });
          item('staff', frac, b.from, { staff: 'char' });
        }
        break;
      }
      case B.POWDER_KEG:
        if (typeof this.hooks.kegBurning === 'function' && this.hooks.kegBurning(q, y, r)) item('glow', 1, FUSE_AT_BUNG, { glow: 'fuse' });
        break;
      default:
        break;
    }
  }

  /** @returns {number[]} indexed cells within `range` of (x, y, z) passing `keep`, nearest first */
  _cellsNear(x, y, z, range, keep) {
    const r2 = range * range;
    /** @type {number[]} */
    const list = [];
    /** @type {number[]} */
    const d2 = [];
    const span = Math.ceil(range / CHUNK_SIZE) + 2;
    const r0 = Math.round(z / HEX_ROW_SPACING);
    const q0 = Math.round(x - r0 / 2);
    const cq0 = worldToChunk(q0);
    const cr0 = worldToChunk(r0);
    for (let dq = -span; dq <= span; dq++) {
      for (let dr = -span; dr <= span; dr++) {
        const set = this.byChunk.get(chunkKey(cq0 + dq, cr0 + dr));
        if (!set) continue;
        for (const pc of set) {
          const id = /** @type {number} */ (this.cells.get(pc));
          if (!keep(id)) continue;
          const d = this._dist2(pc, x, y, z);
          if (d > r2) continue;
          list.push(pc);
          d2.push(d);
        }
      }
    }
    const order = list.map((_, i) => i).sort((a, b) => d2[a] - d2[b]);
    return order.map((i) => list[i]);
  }

  /**
   * What circuitGeometry draws the static wiring from (§4.11). The object is reused.
   * @returns {{ cellsNear(x: number, y: number, z: number, range: number): number[], get(q: number, y: number, r: number): number,
   *   inputFace(q: number, y: number, r: number): number, grounded(q: number, y: number, r: number): boolean,
   *   burning(q: number, y: number, r: number): { t: number, from: number }|null }}
   */
  geometryView() {
    if (this._view) return this._view;
    this._view = {
      cellsNear: (x, y, z, range) => this._cellsNear(x, y, z, range, (id) => id !== B.CAMPFIRE),
      get: (q, y, r) => (y >= 0 && y < H ? this.cells.get(packCell(q, y, r)) ?? B.AIR : B.AIR),
      inputFace: (q, y, r) => (y >= 0 && y < H ? this._inputFace(packCell(q, y, r)) : DEFAULT_INPUT_FACE),
      grounded: (q, y, r) => {
        if (!(y >= 0 && y < H)) return false;
        const pc = packCell(q, y, r);
        return this.cells.get(pc) === B.EARTH_WIRE && this._ground(pc);
      },
      burning: (q, y, r) => this.burningAt(q, y, r),
    };
    return this._view;
  }

  /** @returns {{ t: number, from: number }|null} a burning fuse cell's seconds left and the face its flame came in by */
  burningAt(q, y, r) {
    if (!(y >= 0 && y < H)) return null;
    const b = this.burning.get(packCell(q, y, r));
    return b ? { t: b.ticks * TICK, from: b.from } : null;
  }

  /** @returns {{ cells: number, parts: number, networks: number, active: number, frozen: number, burning: number, timers: number,
   *   scheduled: number, dirty: number, visits: number, ms: number }} */
  stats() {
    let parts = 0;
    for (const id of this.cells.values()) if (isPart(id)) parts++;
    let active = 0;
    let frozen = 0;
    for (const n of this.networks) {
      if (n.frozen) frozen++;
      else if (n.amps > 0 && n.sources.length > 0) active++;
    }
    let timers = 0;
    let scheduled = 0;
    for (const rt of this.rt.values()) {
      if (rt.id === B.CLOCKWORK_TIMER && rt.tphase !== T_IDLE && rt.tphase !== T_HOLD) timers++;
      if (rt.armPending > 0 || rt.arrive > 0) scheduled++;
    }
    return {
      cells: this.cells.size, parts, networks: this.networks.size, active, frozen, burning: this.burning.size, timers, scheduled,
      dirty: this._dq.length - this._dqHead, visits: this._stats.visits, ms: this._stats.ms,
    };
  }

  /** `circuits status`: "circuits on · 214 parts, 12 networks, 3 fuses burning, 2 timers running" */
  status() {
    const s = this.stats();
    const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    return `circuits ${this.enabled ? 'on' : 'off'} · ${pl(s.parts, 'part')}, ${pl(s.networks, 'network')}, ` +
      `${s.burning} fuse${s.burning === 1 ? '' : 's'} burning, ${s.timers} timer${s.timers === 1 ? '' : 's'} running`;
  }
}

/** @returns {string} "400 m" (and the distress mark on 600 m) */
function wavelengthText(ch) {
  return `${wavelengthOf(ch)} m${ch === RADIO_DISTRESS_CH ? ' (distress)' : ''}`;
}

/** @returns {string} "sent on 400 m: 2 receivers in range" */
function sentText(ch, n) {
  return `sent on ${wavelengthOf(ch)} m: ${n} receiver${n === 1 ? '' : 's'} in range`;
}

/** @returns {string} why a device standing on block `id` is not earthed (rule 1's first cell is not earth) */
function insulatorReason(id) {
  if (id === B.AIR || (!getBlockDef(id).solid && !isPart(id))) return 'not earthed: it stands on nothing that conducts — set it on soil or stone';
  const def = getBlockDef(id);
  if (WOOD_NAMES.test(def.name)) return 'not earthed: wood does not conduct — run an Earth Wire down to the ground';
  const what = isPart(id) ? `a ${def.displayName}` : def.displayName.toLowerCase();
  return `not earthed: ${what} does not conduct — run an Earth Wire down to the ground`;
}

/** The repeat timer's closed time in seconds for a delay s (§4.6), exported for tests and the panel. */
export function repeatClosedSeconds(s) {
  const sTicks = ticksOf(Math.min(TIMER_MAX_S, Math.max(TIMER_MIN_S, s)));
  return repeatClosedTicks(sTicks) * TICK;
}
