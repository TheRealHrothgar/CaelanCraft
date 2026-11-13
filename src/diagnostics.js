// Caelancraft — runtime diagnostics: URL parameters, error capture, the `window.__caelancraft` debug
// handle, the F3 overlay text and the in-page `?smoke=1` self-test.
// See src/CONTRACTS.md §22, docs/PLAN-build.md §3–§4 and docs/SPEC-gameplay.md §5.5.
//
// The DOM (window / document / location) is only touched inside functions and only through the `win`
// argument or guarded `typeof` checks, so this module also loads and runs under Node (tests, harness).
// The F3 day counter comes from game.getDay() (provided by main.js), falling back to stats.day / 1.
import { VERSION, WORLD_HEIGHT, FLY_VERTICAL_SPEED, SAVE_SLOTS } from './config.js';
import { BLOCK, BIOME_NAMES, getBlockDef, isBreakable, isSolid } from './blocks.js';
import { worldToChunk, worldToLocal, lookDirection, yawToForward } from './coords.js';
import { FACE_NAMES, faceNeighbor, hexLength, hexToWorld, worldToHex } from './hex.js';
import { runeKey } from './runes.js';

/** @typedef {import('./types.js').GameContext} GameContext */
/** @typedef {import('./types.js').SmokeResult} SmokeResult */
/** @typedef {import('./types.js').RaycastHit} RaycastHit */

/**
 * Parsed URL parameters (all optional).
 * @typedef {Object} Params
 * @property {string|null} seed      raw (trimmed) seed text; main normalises it
 * @property {number|null} rd        render distance, integer clamped to RD_MIN..RD_MAX
 * @property {boolean} smoke
 * @property {boolean} autoplay
 * @property {boolean} nosave
 * @property {boolean} debug
 * @property {boolean} fly
 * @property {number|null} time      frozen time of day, clamped to 0..1
 * @property {number|null} yaw       initial look yaw in DEGREES (0 = north/−Z, 90 = west/−X, 180 = south/+Z, 270 = east/+X)
 * @property {number|null} pitch     initial look pitch in DEGREES, clamped to ±89.9 (negative looks down)
 * @property {string|null} ui        screenshot aid with ?autoplay: 'console' opens the console, 'editor' places a rune block ahead and opens its editor, 'picker' opens the block picker, 'pack' the Pack & Making screen (Survival), 'device' the device panel on a demo Clockwork Timer (v0.10)
 * @property {'vortex'|'circuits'|null} scene  v0.10 (DESIGN-circuits §6.7): 'vortex' sets off a Collapsar Charge 8 cells ahead 2 s
 *   after loading; 'circuits' builds the §4.14 worked examples ahead (readSceneParam, circuitSceneWrites)
 * @property {number|null} slot      save slot 1..SAVE_SLOTS for ?autoplay (§41; main defaults to 1); anything else → null
 * @property {'creative'|'survival'|null} mode  v0.9 (§9.10): the first world's mode with ?autoplay / ?smoke; anything else → null
 * @property {boolean} soundTest     v0.16 (CONTRACTS §82): `?ui=sounds` — main opens the Sound Test as soon as the page has loaded
 */

/** @typedef {{ message: string, stack: string }} ErrorInfo */

export const RD_MIN = 1;
export const RD_MAX = 16;

// ---------------------------------------------------------------------------------------------
// §22.1 parseParams
// ---------------------------------------------------------------------------------------------

/**
 * Parse the game's URL parameters.
 * @param {string|URLSearchParams} [search]  `location.search`, a bare query, a full URL or a URLSearchParams
 * @returns {Params}
 */
export function parseParams(search = defaultSearch()) {
  const params = toSearchParams(search);
  return {
    seed: readString(params, 'seed'),
    rd: readClampedInt(params, 'rd', RD_MIN, RD_MAX),
    smoke: readFlag(params, 'smoke'),
    autoplay: readFlag(params, 'autoplay'),
    nosave: readFlag(params, 'nosave'),
    debug: readFlag(params, 'debug'),
    fly: readFlag(params, 'fly'),
    time: readClampedFloat(params, 'time', 0, 1),
    yaw: readNumber(params, 'yaw'),
    pitch: readClampedFloat(params, 'pitch', -89.9, 89.9),
    ui: readUiParam(params),
    slot: readSlotParam(params),
    mode: readModeParam(params),
    scene: readSceneParam(params),
    soundTest: readSoundTestParam(params),
  };
}

/**
 * `?ui=sounds` (case-insensitive): open the Sound Test at once, over the title screen (CONTRACTS §82). It is not one of
 * the `ui` screenshot aids: it needs no ?autoplay and no world, so `Params.ui` stays null for it.
 * @param {URLSearchParams} params
 * @returns {boolean}
 */
function readSoundTestParam(params) {
  const t = readString(params, 'ui');
  return t !== null && t.toLowerCase() === 'sounds';
}

/**
 * `?scene=vortex|circuits` (case-insensitive), anything else null (DESIGN-circuits §6.7).
 * @param {URLSearchParams} params
 * @returns {'vortex'|'circuits'|null}
 */
export function readSceneParam(params) {
  const t = readString(params, 'scene');
  if (t === null) return null;
  const v = t.toLowerCase();
  return v === 'vortex' || v === 'circuits' ? v : null;
}

// ---------------------------------------------------------------------------------------------
// v0.10 `?scene=circuits`: the named worked examples of DESIGN-circuits §4.14, as cells for main to write
// ---------------------------------------------------------------------------------------------

/**
 * The worked examples ?scene=circuits builds (§6.7), each one row along +q at one height, rows SCENE_ROW_GAP apart in r:
 * `[dq, name, id]` cells, the input faces `[dq, face]` and the settings `[dq, partial]`. Example 2 has a keg in place of the
 * charge; `switch` is example 10 with one key (a Knife Switch firing an Igniter into a keg).
 */
export const CIRCUIT_SCENE_ROWS = Object.freeze([
  Object.freeze({
    name: 'doorbell', // §4.14 example 1: hold right-click on the button and the bell rings
    cells: [[0, 'battery', BLOCK.VOLTAIC_BATTERY], ...span(1, 6, BLOCK.COPPER_WIRE), [7, 'button', BLOCK.PUSH_BUTTON],
      ...span(8, 10, BLOCK.COPPER_WIRE), [11, 'bell', BLOCK.ELECTRIC_BELL]],
    faces: [],
    settings: [[7, { l: 'Front door' }]],
  }),
  Object.freeze({
    name: 'timer', // example 2 with a keg: right-click the timer; 30 s later the igniter fires and the keg goes off
    cells: [[0, 'battery', BLOCK.VOLTAIC_BATTERY], [1, 'timer', BLOCK.CLOCKWORK_TIMER], ...span(2, 5, BLOCK.COPPER_WIRE),
      [6, 'igniter', BLOCK.IGNITER], [7, 'keg', BLOCK.POWDER_KEG]],
    faces: [[1, 1]], // SE (unused)
    settings: [[1, { s: 30, m: 'pulse', l: 'Quarry clock' }]],
  }),
  Object.freeze({
    name: 'switch', // example 10 with one key: close the switch and the keg goes off
    cells: [[0, 'battery', BLOCK.VOLTAIC_BATTERY], [1, 'knife', BLOCK.KNIFE_SWITCH], ...span(2, 3, BLOCK.COPPER_WIRE),
      [4, 'igniter', BLOCK.IGNITER], [5, 'keg', BLOCK.POWDER_KEG]],
    faces: [],
    settings: [],
  }),
  Object.freeze({
    name: 'lamp', // example 7: the dusk lamp — the NC relay lights the lamp when the selenium panel goes dark
    cells: [[0, 'panel', BLOCK.SELENIUM_PANEL], [1, 'wire', BLOCK.COPPER_WIRE], [2, 'relay', BLOCK.RELAY],
      [3, 'battery', BLOCK.VOLTAIC_BATTERY]],
    extra: [[2, 1, 'lamp', BLOCK.FILAMENT_LAMP]], // [dq, dr, name, id]: on the relay's SE face
    faces: [[2, 3]], // W
    settings: [[2, { nc: true }]],
  }),
]);
/**
 * Rows of ?scene=circuits are this many cells apart in r (5.2 units): more than BLAST_RADIUS 3.5, so the timer row's keg
 * neither sets off the switch row's keg nor blows up the rows beside it (at 3 apart it took the dusk lamp's relay too).
 */
export const SCENE_ROW_GAP = 6;

/** @returns {Array<[number, string, number]>} cells dq0..dq1 of one id (unnamed) */
function span(dq0, dq1, id) {
  const out = [];
  for (let dq = dq0; dq <= dq1; dq++) out.push([dq, '', id]);
  return out;
}

/**
 * The cells, input faces and settings of ?scene=circuits with its first row's first cell at (q0, y, r0) (DESIGN-circuits
 * §6.7; main flattens the ground, writes the blocks with world.setBlock, then sets the faces and the settings).
 * @param {number} q0 @param {number} y @param {number} r0
 * @returns {{ blocks: [number, number, number, number][], faces: [number, number, number, number][],
 *   settings: [number, number, number, object][], named: Record<string, [number, number, number]>,
 *   bounds: { q0: number, q1: number, r0: number, r1: number } }}  bounds: the cells' extent (main flattens it, plus 2)
 */
export function circuitSceneWrites(q0, y, r0) {
  /** @type {[number, number, number, number][]} */
  const blocks = [];
  /** @type {[number, number, number, number][]} */
  const faces = [];
  /** @type {[number, number, number, object][]} */
  const settings = [];
  /** @type {Record<string, [number, number, number]>} */
  const named = {};
  CIRCUIT_SCENE_ROWS.forEach((row, i) => {
    const r = r0 + i * SCENE_ROW_GAP;
    for (const [dq, name, id] of row.cells) {
      blocks.push([q0 + dq, y, r, id]);
      if (name) named[`${row.name}.${name}`] = [q0 + dq, y, r];
    }
    for (const [dq, dr, name, id] of /** @type {*} */ (row).extra ?? []) {
      blocks.push([q0 + dq, y, r + dr, id]);
      named[`${row.name}.${name}`] = [q0 + dq, y, r + dr];
    }
    for (const [dq, face] of row.faces) faces.push([q0 + dq, y, r, face]);
    for (const [dq, partial] of row.settings) settings.push([q0 + dq, y, r, partial]);
  });
  const bounds = { q0: Infinity, q1: -Infinity, r0: Infinity, r1: -Infinity };
  for (const [q, , r] of blocks) {
    bounds.q0 = Math.min(bounds.q0, q);
    bounds.q1 = Math.max(bounds.q1, q);
    bounds.r0 = Math.min(bounds.r0, r);
    bounds.r1 = Math.max(bounds.r1, r);
  }
  return { blocks, faces, settings, named, bounds };
}

/**
 * `?mode=creative|survival` (case-insensitive), anything else null (DESIGN-survival §9.10).
 * @param {URLSearchParams} params
 * @returns {'creative'|'survival'|null}
 */
export function readModeParam(params) {
  const t = readString(params, 'mode');
  if (t === null) return null;
  const v = t.toLowerCase();
  return v === 'creative' || v === 'survival' ? v : null;
}

/** An integer 1..SAVE_SLOTS, else null (out of range is ignored rather than clamped: slot=9 must not play slot 6). */
function readSlotParam(params) {
  const n = readNumber(params, 'slot');
  return n !== null && Number.isInteger(n) && n >= 1 && n <= SAVE_SLOTS ? n : null;
}

/** `location.search` in a browser, '' anywhere else (never throws under Node). */
function defaultSearch() {
  if (typeof location !== 'undefined' && location && typeof location.search === 'string') return location.search;
  return '';
}

/**
 * @param {string|URLSearchParams|null|undefined} search
 * @returns {URLSearchParams}
 */
function toSearchParams(search) {
  if (search && typeof search === 'object' && typeof search.get === 'function') return /** @type {URLSearchParams} */ (search);
  let s = search == null ? '' : String(search);
  const q = s.indexOf('?');
  if (q >= 0) s = s.slice(q + 1); // tolerate a full URL or a leading '?'
  const h = s.indexOf('#');
  if (h >= 0) s = s.slice(0, h); // drop a fragment
  return new URLSearchParams(s);
}

/** @returns {string|null} trimmed value, or null when absent or empty */
function readString(params, name) {
  const v = params.get(name);
  if (v === null) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/** '1' / 'true' (case-insensitive) → true; a bare `?flag` (empty value) also counts as true. */
function readFlag(params, name) {
  const v = params.get(name);
  if (v === null) return false;
  const t = v.trim().toLowerCase();
  return t === '1' || t === 'true' || t === '';
}

/** @returns {number|null} finite number, or null when absent / empty / not numeric */
function readNumber(params, name) {
  const t = readString(params, name);
  if (t === null) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 'console' | 'editor' | 'picker' | 'pack' | 'device' | null */
function readUiParam(params) {
  const t = readString(params, 'ui');
  if (t === null) return null;
  const v = t.toLowerCase();
  return v === 'console' || v === 'editor' || v === 'picker' || v === 'pack' || v === 'device' ? v : null;
}

function readClampedInt(params, name, lo, hi) {
  const n = readNumber(params, name);
  if (n === null) return null;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

function readClampedFloat(params, name, lo, hi) {
  const n = readNumber(params, name);
  if (n === null) return null;
  return Math.min(hi, Math.max(lo, n));
}

// ---------------------------------------------------------------------------------------------
// §22.2 installErrorCapture
// ---------------------------------------------------------------------------------------------

/** Upper bound on recorded error messages so a runaway error loop cannot grow memory unboundedly. */
export const MAX_RECORDED_ERRORS = 200;

/** Per-window error log shared by installErrorCapture and the debug handle (`__caelancraft.errors`).
 * @type {WeakMap<object, string[]>} */
const errorLogs = new WeakMap();

/** Per-window game context handed to installDebugHandle, so updateDebugHandle can refresh live refs.
 * @type {WeakMap<object, GameContext|null>} */
const gameByWin = new WeakMap();

/** @param {object} win @returns {string[]} */
function errorLogFor(win) {
  let log = errorLogs.get(win);
  if (!log) {
    log = [];
    errorLogs.set(win, log);
  }
  return log;
}

/** Append `message` to `log`, respecting MAX_RECORDED_ERRORS (one trailing marker when saturated). */
function pushBounded(log, message) {
  if (log.length < MAX_RECORDED_ERRORS) log.push(message);
  else if (log.length === MAX_RECORDED_ERRORS) log.push('... further errors suppressed');
}

/** @param {object} win @param {ErrorInfo} info */
function recordError(win, info) {
  const log = errorLogFor(win);
  pushBounded(log, info.message);
  // main may have replaced the handle's array; keep whatever `__caelancraft.errors` points at in sync too.
  const handle = win.__caelancraft;
  if (handle && Array.isArray(handle.errors) && handle.errors !== log) pushBounded(handle.errors, info.message);
}

/** Best-effort string form of an arbitrary thrown value. */
function safeString(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      if (typeof json === 'string' && json !== '{}') return json;
    } catch {
      /* circular or non-serialisable: fall through to String() */
    }
  }
  try {
    return String(value);
  } catch {
    return '[unprintable value]';
  }
}

/** @param {*} err @returns {string} */
function errMessage(err) {
  if (err && typeof err === 'object' && 'message' in err) return String(err.message);
  return safeString(err);
}

/** @param {*} err @returns {string} */
function errStack(err) {
  return err && typeof err === 'object' && typeof err.stack === 'string' ? err.stack : '';
}

/** @param {ErrorEvent|*} e @returns {ErrorInfo} */
function describeErrorEvent(e) {
  const err = e ? e.error : undefined;
  let message = '';
  if (err !== undefined && err !== null) message = errMessage(err);
  if (!message && e && typeof e.message === 'string') message = e.message;
  if (!message) message = 'Unknown error';
  const stack = errStack(err);
  if (!stack && e && typeof e.filename === 'string' && e.filename) {
    message += ` (${e.filename}:${e.lineno ?? '?'}:${e.colno ?? '?'})`;
  }
  return { message, stack };
}

/** @param {PromiseRejectionEvent|*} e @returns {ErrorInfo} */
function describeRejection(e) {
  const reason = e ? e.reason : undefined;
  const message = reason === undefined ? 'unhandled promise rejection' : errMessage(reason);
  return { message: `Unhandled rejection: ${message}`, stack: errStack(reason) };
}

/**
 * Forward uncaught errors and unhandled promise rejections to `onError({message, stack})` and record
 * their messages in the per-window log that backs `__caelancraft.errors`.
 * @param {Window|*} win
 * @param {(info: ErrorInfo) => void} onError
 * @returns {() => void} uninstall function
 */
export function installErrorCapture(win, onError) {
  if (!win || typeof win.addEventListener !== 'function') return () => {};
  const report = (info) => {
    recordError(win, info);
    if (typeof onError === 'function') {
      try {
        onError(info);
      } catch {
        // A throwing reporter would re-enter the 'error' event and loop forever; swallow it.
      }
    }
  };
  const onErrorEvent = (e) => report(describeErrorEvent(e));
  const onRejection = (e) => report(describeRejection(e));
  win.addEventListener('error', onErrorEvent);
  win.addEventListener('unhandledrejection', onRejection);
  return () => {
    if (typeof win.removeEventListener !== 'function') return;
    win.removeEventListener('error', onErrorEvent);
    win.removeEventListener('unhandledrejection', onRejection);
  };
}

// ---------------------------------------------------------------------------------------------
// §22.3 installDebugHandle / updateDebugHandle
// ---------------------------------------------------------------------------------------------

/** Copy the live object references out of the game context onto the handle. */
function refreshHandleRefs(handle, game) {
  const world = game ? game.world ?? null : null;
  const renderer = game ? game.renderer ?? null : null;
  const three = renderer && renderer.three ? renderer.three : null;
  handle.world = world;
  handle.player = game ? game.player ?? null : null;
  handle.controls = game ? game.controls ?? null : null;
  handle.renderer = renderer;
  handle.runes = game ? game.runes ?? null : null;
  handle.runner = game ? game.runner ?? null : null;
  handle.physics = game ? game.physics ?? null : null;
  handle.zombies = game ? game.zombies ?? null : null;
  handle.watcher = game ? game.watcher ?? null : null;
  handle.survival = game ? game.survival ?? null : null; // v0.9 (§9.10)
  handle.pack = game ? game.pack ?? null : null;
  handle.circuits = game ? game.circuits ?? null : null; // v0.10 (DESIGN-circuits §6.6)
  handle.circuitStore = game ? game.circuitStore ?? null : null;
  handle.blackHoles = game ? game.blackHoles ?? null : null;
  handle.infall = game ? game.infall ?? null : null;
  handle.animals = game ? game.animals ?? null : null; // v0.11 (CONTRACTS §69)
  handle.loose = game ? game.loose ?? null : null; // v0.10 (CONTRACTS §60)
  handle.growth = game ? game.growth ?? null : null; // §80: the planted cells and sprouts (farming.js Growth)
  handle.spread = game ? game.spread ?? null : null; // §80: the wild plants' spreading and its counts (spread.js Spread)
  handle.weather = game ? game.weather ?? null : null; // §84: the live world's weather (weather.js createWeather)
  handle.camera = three ? three.camera ?? null : null;
  handle.scene = three ? three.scene ?? null : null;
  handle.seed = world && world.seed != null ? world.seed : handle.seed ?? null;
}

/**
 * Install `win.__caelancraft`, the console / automation handle. Re-installing (new world, quit to title)
 * keeps the same object, its error log and any previous smoke result, and rebinds the helpers to `game`.
 * The helpers read `game.world` etc. lazily so they work even when the world is created after boot.
 * @param {Window|*} win
 * @param {GameContext|null} game
 * @returns {object|null} the handle (null when `win` is missing)
 */
export function installDebugHandle(win, game) {
  if (!win || typeof win !== 'object') return null;
  gameByWin.set(win, game ?? null);

  const existing = win.__caelancraft;
  const handle = existing && typeof existing === 'object' ? existing : {};
  const errors = errorLogFor(win);
  if (Array.isArray(handle.errors) && handle.errors !== errors) {
    for (const entry of handle.errors) pushBounded(errors, typeof entry === 'string' ? entry : errMessage(entry));
  }

  handle.version = VERSION;
  handle.ready = false;
  handle.stats = handle.stats && typeof handle.stats === 'object' ? handle.stats : {};
  handle.errors = errors;
  handle.smoke = handle.smoke ?? null;
  refreshHandleRefs(handle, game);

  const worldOf = () => (game && game.world ? game.world : null);
  // Console helpers take WORLD positions (what the F3 overlay shows as XYZ); the cell is derived from them.
  handle.getBlock = (x, y, z) => {
    const w = worldOf();
    return w ? w.getBlockAt(x, y, z) : BLOCK.AIR;
  };
  handle.setBlock = (x, y, z, id) => {
    const w = worldOf();
    if (!w || !Number.isFinite(x + y + z)) return false;
    const [q, r] = worldToHex(x, z);
    return w.setBlock(q, Math.floor(y), r, id);
  };
  handle.getCell = (x, z) => (Number.isFinite(x + z) ? worldToHex(x, z) : null);
  /** Run one console command line (the same executor as the T console and rune scripts). */
  handle.runCommand = (line) => (game && typeof game.runCommand === 'function' ? game.runCommand(String(line)) : null);
  handle.teleport = (x, y, z) => {
    if (game && typeof game.teleport === 'function') game.teleport(x, y, z);
  };
  handle.setTime = (t) => {
    if (game && typeof game.setTime === 'function') game.setTime(t);
  };
  // Extra conveniences for console debugging (not required by the contract).
  handle.getTime = () => (game && typeof game.getTime === 'function' ? game.getTime() : NaN);
  handle.getHit = () => (game && typeof game.getHit === 'function' ? game.getHit() : null);
  handle.setLook = (yaw, pitch) => {
    if (game && typeof game.setLook === 'function') game.setLook(yaw, pitch);
  };
  handle.getState = () => (game && typeof game.getState === 'function' ? game.getState() : 'unknown');
  // v0.9 Survival (§9.10): the mode (switches are queued), and one frame of the real dig / use / R paths for drivers.
  handle.getMode = () => (game && typeof game.getMode === 'function' ? game.getMode() : 'creative');
  handle.setMode = (mode) => {
    if (game && typeof game.setMode === 'function') game.setMode(mode);
  };
  handle.selectSlot = (i) => {
    if (game && typeof game.selectSlot === 'function') game.selectSlot(i);
  };
  handle.digTargeted = (dt) => (game && typeof game.digTargeted === 'function' ? game.digTargeted(dt) : null);
  // v0.10 (CONTRACTS §60): Q / G — drop or throw the item in hand
  handle.handAction = (kind, n) => (game && typeof game.handAction === 'function' ? game.handAction(kind, n) : null);
  // v0.11 (§72): a left click on the target, as the smoke test drives it (Creative breaks; a mob is struck)
  handle.breakTargeted = () => (game && typeof game.breakTargeted === 'function' ? game.breakTargeted() : null);
  // v0.11 (CONTRACTS §69): R on the targeted animal, and the horse being ridden
  handle.animalR = () => (game && typeof game.animalR === 'function' ? game.animalR() : false);
  handle.getRiding = () => (game && typeof game.getRiding === 'function' ? game.getRiding() : null);
  handle.useSelected = (dt) => (game && typeof game.useSelected === 'function' ? game.useSelected(dt) : null);
  // §80: run the growth and spread steps as if `seconds` had passed (the in-game check of farming)
  handle.farmStep = (seconds) => (game && typeof game.farmStep === 'function' ? game.farmStep(seconds) : null);
  // §84: today's season, forcing the weather ('rain', 'dry', null for the real one) and setting the day counter
  handle.season = () => (game && typeof game.season === 'function' ? game.season() : null);
  handle.weatherEnv = () => (game && typeof game.weatherEnv === 'function' ? game.weatherEnv() : null);
  handle.setWeather = (mode) => (game && typeof game.setWeather === 'function' ? game.setWeather(mode) : null);
  handle.setDay = (n) => (game && typeof game.setDay === 'function' ? game.setDay(n) : null);
  handle.interact = () => {
    if (game && typeof game.interact === 'function') game.interact();
  };
  // v0.10 (DESIGN-circuits §6.6): one frame of right-click on the target (the real control-latch path), Shift+R, the scenes.
  handle.rightClick = (pressed, dt) => (game && typeof game.rightClick === 'function' ? game.rightClick(pressed, dt) : null);
  handle.rightRelease = () => {
    if (game && typeof game.rightRelease === 'function') game.rightRelease();
  };
  handle.editTarget = () => {
    if (game && typeof game.editTarget === 'function') game.editTarget();
  };
  handle.buildScene = (name) => (game && typeof game.buildScene === 'function' ? game.buildScene(name) : null);
  /** One synchronous simulation + render step (screenshots under a virtual-time budget, where rAF is starved). */
  handle.stepFrame = (dt) => {
    if (game && typeof game.stepFrame === 'function') game.stepFrame(dt);
  };
  handle.runSmoke = () => runSmokeTest(game, win);

  win.__caelancraft = handle;
  return handle;
}

/**
 * Merge `stats` into `__caelancraft.stats`, refresh the live references and flag the handle ready.
 * Called by main every ~250 ms. Installs a bare handle if none exists yet.
 * @param {Window|*} win
 * @param {object} stats
 * @returns {object|null} the handle
 */
export function updateDebugHandle(win, stats) {
  if (!win || typeof win !== 'object') return null;
  let handle = win.__caelancraft;
  if (!handle || typeof handle !== 'object') handle = installDebugHandle(win, gameByWin.get(win) ?? null);
  if (!handle.stats || typeof handle.stats !== 'object') handle.stats = {};
  if (stats && typeof stats === 'object') Object.assign(handle.stats, stats);
  refreshHandleRefs(handle, gameByWin.get(win) ?? null);
  handle.ready = true;
  return handle;
}

// ---------------------------------------------------------------------------------------------
// §22.4 buildDebugText (F3 overlay, SPEC-gameplay §5.5)
// ---------------------------------------------------------------------------------------------

const MINUTES_PER_DAY = 24 * 60;
const CLOCK_EPS = 1e-7;
const RAD_TO_DEG = 180 / Math.PI;
const EMPTY_STATS = Object.freeze({});

/** @returns {string} "HH:MM" for a day fraction (wraps; same rounding as daynight.formatTime) */
export function formatClock(time) {
  if (!Number.isFinite(time)) return '--:--';
  const t = time - Math.floor(time);
  let minutes = Math.floor(t * MINUTES_PER_DAY + CLOCK_EPS);
  if (minutes >= MINUTES_PER_DAY) minutes = 0;
  const h = Math.floor(minutes / 60);
  const m = minutes - h * 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Cardinal direction text from a horizontal forward vector (SPEC-gameplay §5.5 rule). */
export function facingName(fx, fz) {
  if (Math.abs(fx) > Math.abs(fz)) return fx > 0 ? 'east (+X)' : 'west (-X)';
  return fz > 0 ? 'south (+Z)' : 'north (-Z)';
}

/** Radians → degrees normalised to [-180, 180). */
function yawDegrees(yaw) {
  const deg = yaw * RAD_TO_DEG;
  return deg - Math.floor((deg + 180) / 360) * 360;
}

function fmt1(v) {
  return Number.isFinite(v) ? v.toFixed(1) : '-';
}

function fmt3(v) {
  return Number.isFinite(v) ? v.toFixed(3) : '-';
}

function fmtInt(v) {
  return Number.isFinite(v) ? String(Math.round(v)) : '-';
}

/** Loaded / meshed / queued chunk counts. Prefers the live World; falls back to stats fields. */
function chunkCounts(world, pcq, pcr, stats) {
  if (world && world.chunks && typeof world.chunks.values === 'function') {
    const rd = Number.isFinite(world.renderDistance) ? world.renderDistance : Infinity;
    let loaded = 0;
    let meshed = 0;
    let queue = 0;
    for (const c of world.chunks.values()) {
      loaded++;
      if (c.meshed) meshed++;
      if (c.dirty && hexLength(c.cq - pcq, c.cr - pcr) <= rd) queue++;
    }
    return { loaded, meshed, queue };
  }
  return {
    loaded: Number(stats.chunksLoaded) || 0,
    meshed: Number(stats.chunkMeshes ?? stats.meshesVisible) || 0,
    queue: Number(stats.chunksDirty ?? stats.queue) || 0,
  };
}

/** @param {GameContext|*} game @returns {RaycastHit|null} */
function currentHit(game) {
  if (!game || typeof game.getHit !== 'function') return null;
  try {
    return game.getHit() ?? null;
  } catch {
    return null;
  }
}

/**
 * Build the multi-line debug overlay text. Tolerates a partially initialised game (no world / player yet).
 * @param {GameContext|*} game
 * @param {object} stats  main's stats bag: at least { fps, frameMs }; optionally day and chunk counters
 * @returns {string}
 */
export function buildDebugText(game, stats) {
  const s = stats && typeof stats === 'object' ? stats : EMPTY_STATS;
  const g = game && typeof game === 'object' ? game : EMPTY_STATS;
  const player = g.player ?? null;
  const world = g.world ?? null;
  const controls = g.controls ?? null;

  const px = player && Number.isFinite(player.x) ? player.x : 0;
  const py = player && Number.isFinite(player.y) ? player.y : 0;
  const pz = player && Number.isFinite(player.z) ? player.z : 0;
  const [bq, br] = worldToHex(px, pz);
  const by = Math.floor(py);
  const cq = worldToChunk(bq);
  const cr = worldToChunk(br);
  const lq = worldToLocal(bq);
  const lr = worldToLocal(br);

  const yaw = controls && Number.isFinite(controls.yaw) ? controls.yaw : 0;
  const pitch = controls && Number.isFinite(controls.pitch) ? controls.pitch : 0;
  const dir = lookDirection(yaw, pitch);

  let biome = 'unknown';
  if (world && typeof world.getBiome === 'function') biome = BIOME_NAMES[world.getBiome(bq, br)] ?? 'unknown';
  const seed = world && world.seed != null ? world.seed : '?';
  const counts = chunkCounts(world, cq, cr, s);

  const hit = currentHit(g);
  let target = 'none';
  if (hit) {
    const [hx, hz] = hexToWorld(hit.q, hit.r);
    target = `${getBlockDef(hit.blockId).name} cell (${hit.q}, ${hit.y}, ${hit.r}) face ${faceName(hit.face)}  centre ${hx.toFixed(2)} ${hz.toFixed(2)}`;
  }

  const time = typeof g.getTime === 'function' ? Number(g.getTime()) : NaN;
  const day = typeof g.getDay === 'function' ? g.getDay() : s.day ?? 1;

  let mode = '';
  if (player) {
    if (player.flying) mode += 'fly';
    if (player.sprinting) mode += (mode ? ' | ' : '') + 'sprint';
    if (player.sneaking) mode += (mode ? ' | ' : '') + 'sneak';
    if (player.inWater) mode += (mode ? ' | ' : '') + 'swimming';
  }
  if (!mode) mode = 'walk';

  // Block physics (v0.8): one compact line when the game has it.
  let physicsLine = '';
  const ph = g.physics ?? null;
  if (ph && typeof ph.status === 'function') {
    const st = ph.status();
    const q = st.queued;
    const off = Object.keys(st.switches).filter((k) => !st.switches[k]);
    physicsLine = `\nPhysics: ${st.paused ? 'PAUSED  ' : ''}queued ${q.fall + q.water + q.misc}  falling ${st.fallers}  tumbling ${st.tumblers}` +
      `  tick ${fmt1(st.lastTickMs)} ms${off.length ? `  off: ${off.join(' ')}` : ''}`;
  }

  // v0.10 (DESIGN-circuits §6.7): the circuits and black-hole lines, when there is something to report.
  let circuitLines = '';
  const cs = g.circuits && typeof g.circuits.stats === 'function' ? g.circuits.stats() : null;
  const segs = typeof g.circuitSegments === 'function' ? g.circuitSegments() : 0;
  if (cs) circuitLines += circuitsDebugLine(cs, segs);
  circuitLines += blackHolesDebugLine(g.blackHoles ?? null, g.infall ?? null);

  return (
    `Caelancraft v${VERSION}  (F3 to hide)\n` +
    `FPS: ${fmtInt(s.fps)}  frame ${fmt1(s.frameMs)} ms\n` +
    `XYZ: ${fmt3(px)} / ${fmt3(py)} / ${fmt3(pz)}\n` +
    `Cell (q y r): ${bq} ${by} ${br}   Chunk: ${cq} ${cr}  (local ${lq} ${lr})\n` +
    `Facing: ${facingName(dir[0], dir[2])}  yaw ${fmt1(yawDegrees(yaw))}  pitch ${fmt1(pitch * RAD_TO_DEG)}\n` +
    `Biome: ${biome}   Seed: ${seed}\n` +
    `Chunks: loaded ${counts.loaded}  meshed ${counts.meshed}  queue ${counts.queue}\n` +
    `Target: ${target}\n` +
    `Time: ${formatClock(time)}  day ${day}  (t=${fmt3(time)})\n` +
    `Mode: ${mode}` +
    survivalDebugLine(g.survival ?? null) +
    weatherDebugLine(g) +
    physicsLine +
    circuitLines
  );
}

/** "1.1k" for 1100, "214" for 214. */
function kCount(n) {
  if (!Number.isFinite(n)) return '0';
  return n >= 1000 ? `${(Math.round(n / 100) / 10).toString()}k` : String(Math.round(n));
}

/**
 * The F3 circuits line (DESIGN-circuits §6.7), only when the world has an indexed cell:
 * `Circuits: 214 cells · 31 parts · 12 nets (4 active, 0 frozen) · 3 fuses burning · 2 timers · 0.4 ms/tick · 1.1k segments`.
 * @param {{ cells: number, parts: number, networks: number, active: number, frozen: number, burning: number, timers: number,
 *   ms: number }} s  circuits.stats()
 * @param {number} segments  wire segments drawn
 * @returns {string} '' or the line with its leading newline
 */
export function circuitsDebugLine(s, segments = 0) {
  if (!s || !(s.cells > 0)) return '';
  return `\nCircuits: ${s.cells} cells · ${s.parts} parts · ${s.networks} nets (${s.active} active, ${s.frozen} frozen)` +
    ` · ${s.burning} fuse${s.burning === 1 ? '' : 's'} burning · ${s.timers} timer${s.timers === 1 ? '' : 's'}` +
    ` · ${fmt1(s.ms)} ms/tick · ${kCount(segments)} segments`;
}

/**
 * The F3 black-hole line (DESIGN-circuits §6.7), only when a hole, a charge arming or an infall exists:
 * `Black holes: 3 (1 forming) · 0 inert · infall 12 blocks / 1 mob`.
 * @param {*} bh  BlackHoles
 * @param {*} infall  Infall
 * @returns {string} '' or the line with its leading newline
 */
export function blackHolesDebugLine(bh, infall) {
  if (!bh) return '';
  const size = Number(bh.size) || 0;
  const arming = Number(bh.arming) || 0;
  const inert = Number(bh.inert) || 0;
  const blocks = infall ? Number(infall.blocks) || 0 : 0;
  const mobs = infall ? Number(infall.mobs) || 0 : 0;
  if (size + arming + inert + blocks + mobs === 0) return '';
  let forming = arming;
  if (bh.holes && typeof bh.holes.values === 'function') for (const h of bh.holes.values()) if (h.phase !== 3) forming++;
  return `\nBlack holes: ${size}${forming > 0 ? ` (${forming} forming)` : ''}${bh.enabled === false ? ' · OFF' : ''} · ${inert} inert` +
    ` · infall ${blocks} block${blocks === 1 ? '' : 's'} / ${mobs} mob${mobs === 1 ? '' : 's'}`;
}

/**
 * The F3 survival line (DESIGN-survival §9.10), after `Mode:`, only while Survival is active:
 * `Survival: HP 87 · Nourishment 64 · Hydration 51 · Breath 20 · body 36.9 °C · felt 12.3 °C (air 9.8) · Chilled`.
 * @param {*} sv  a Survival (survival.js) or null
 * @returns {string} '' when there is none or it is not active; otherwise the line with its leading newline
 */
export function survivalDebugLine(sv) {
  if (!sv || !sv.active || !sv.vitals) return '';
  const v = sv.vitals;
  const labels = sv.status && Array.isArray(sv.status.labels) ? sv.status.labels : [];
  return `\nSurvival: HP ${fmtInt(v.health)} · Nourishment ${fmtInt(v.satiation)} · Hydration ${fmtInt(v.hydration)}` +
    ` · Breath ${fmtInt(v.breath)} · body ${fmt1(v.temp)} °C · felt ${fmt1(sv.felt)} °C (air ${fmt1(sv.air)})` +
    (labels.length ? ` · ${labels.join(' · ')}` : '');
}

/**
 * The F3 line of the season and the weather (CONTRACTS §84): `Season: The rains, day 3 of 10 · dryness 0.30 · rain 0.62`
 * (`forced` after the rain when the debug handle forces it). '' for a game without a calendar, or without a world.
 * @param {{ season?: Function, rainNow?: Function, weather?: { forced?: string|null }|null }|null|undefined} g
 * @returns {string}
 */
export function weatherDebugLine(g) {
  if (!g || typeof g.season !== 'function' || !g.weather) return '';
  const s = g.season();
  if (!s) return '';
  const rain = typeof g.rainNow === 'function' ? Number(g.rainNow()) : NaN;
  return `\nSeason: ${s.name}, day ${s.dayOfSeason} of ${s.days} · dryness ${Number(s.dryness).toFixed(2)}` +
    (Number.isFinite(rain) ? ` · rain ${rain.toFixed(2)}` : '') + (g.weather.forced ? ` (forced ${g.weather.forced})` : '');
}

// ---------------------------------------------------------------------------------------------
// §22.5 runSmokeTest (PLAN-build §4)
// ---------------------------------------------------------------------------------------------

/** Frames to wait for main to reach 'playing' (~15 s at 60 fps) before giving up. */
export const SMOKE_MAX_WAIT_PLAYING_FRAMES = 900;
/** Frames the player gets to land after spawning. */
export const SMOKE_GROUND_FRAMES = 120;
/** Frames used for the 360° spin. */
export const SMOKE_SPIN_FRAMES = 60;
/** Frames of upward flight. */
export const SMOKE_FLY_FRAMES = 30;
const SMOKE_REMESH_FRAMES = 30;
const SMOKE_HIT_RETRY_FRAMES = 10;
/** v0.9: frames to wait for a queued mode switch; at most this many 1/60 s dig and eat frames in the survival step. */
const SMOKE_MODE_FRAMES = 10;
const SMOKE_DIG_FRAMES = 240;
/** Frames the smoke test waits for a dug rock to fly into the pack (CONTRACTS §60: about half a second). */
const SMOKE_PICKUP_FRAMES = 120;
const SMOKE_EAT_FRAMES = 180;
const SMOKE_LOOK_DOWN_PITCH = -1.5;
const SMOKE_TELEPORT_DISTANCE = 3;
// Must be shorter than the 25 s virtual-time budget in scripts/smoke-windows-chrome.sh so a stalled
// sequence still reports SMOKE_FAIL before Chrome takes the screenshot.
const SMOKE_WATCHDOG_MS = 20_000;
/**
 * If requestAnimationFrame has not fired within this many ms the ticker advances the game itself via
 * `game.stepFrame`. In a live browser rAF (16 ms) always wins; under headless Chrome's virtual-time budget
 * rAF is starved (a few frames per minute of virtual time) while timers run, so the fallback drives the run.
 */
const SMOKE_RAF_FALLBACK_MS = 40;
const SMOKE_HEADLESS_DT = 1 / 60;

const SMOKE_RESULT_CSS =
  'position:fixed;left:0;bottom:0;z-index:100000;max-width:48vw;max-height:35vh;overflow:hidden;margin:0;' +
  'padding:4px 6px;font:11px/14px monospace;color:#ddd;background:rgba(0,0,0,.55);' +
  'white-space:pre-wrap;word-break:break-all;pointer-events:none;';
const SMOKE_BANNER_CSS =
  'position:fixed;left:0;right:0;top:0;z-index:100001;padding:6px 10px;font:bold 14px/18px monospace;' +
  'color:#fff;text-align:center;text-shadow:1px 1px 0 rgba(0,0,0,.5);pointer-events:none;';
const SMOKE_OK_COLOR = '#1f8f3a';
const SMOKE_FAIL_COLOR = '#a61b1b';

/** `window` in a browser, `globalThis` elsewhere (never throws under Node). */
function defaultWindow() {
  return typeof window !== 'undefined' ? window : globalThis;
}

/** Mutable bookkeeping around a SmokeResult. */
function createSmokeState() {
  /** @type {SmokeResult} */
  const result = {
    done: false,
    ok: false,
    frames: 0,
    chunksLoaded: 0,
    drawCalls: 0,
    playerGrounded: false,
    breakPlaceRoundTrip: false,
    webgl: 'unknown',
    errors: [],
    steps: [],
  };
  let failures = 0;
  return {
    result,
    pass(msg) {
      result.steps.push(`PASS ${msg}`);
    },
    info(msg) {
      result.steps.push(`INFO ${msg}`);
    },
    fail(msg) {
      failures++;
      result.steps.push(`FAIL ${msg}`);
    },
    check(ok, passMsg, failMsg) {
      if (ok) this.pass(passMsg);
      else this.fail(failMsg);
      return !!ok;
    },
    finalize() {
      result.done = true;
      result.ok = failures === 0;
      return result;
    },
  };
}

/**
 * One "frame" of waiting. In a browser this is `requestAnimationFrame` (main's loop advances the game),
 * raced against a SMOKE_RAF_FALLBACK_MS timer that advances the game via `game.stepFrame(dt)` when rAF
 * is starved (headless Chrome under a virtual-time budget). Without rAF (Node harness) it is a macrotask
 * that calls `game.stepFrame(dt)` when provided.
 */
function makeTicker(game, win, result) {
  const raf = win && typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : null;
  const caf = win && typeof win.cancelAnimationFrame === 'function' ? win.cancelAnimationFrame.bind(win) : null;
  const step = game && typeof game.stepFrame === 'function' ? game.stepFrame.bind(game) : null;
  return () =>
    new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        result.frames++;
        resolve();
      };
      if (!raf) {
        setTimeout(() => {
          if (step) step(SMOKE_HEADLESS_DT);
          done();
        }, 0);
        return;
      }
      let timer = null;
      const rafId = raf(() => {
        if (timer !== null) clearTimeout(timer);
        done();
      });
      if (step) {
        timer = setTimeout(() => {
          if (settled) return;
          if (caf) caf(rafId);
          step(SMOKE_HEADLESS_DT);
          done();
        }, SMOKE_RAF_FALLBACK_MS);
      }
    });
}

/** Poll `game.getHit()` once per frame until `accept(hit)` or `maxFrames` elapsed. */
async function waitForHit(game, tick, accept, maxFrames) {
  for (let i = 0; ; i++) {
    const hit = game.getHit() ?? null;
    if (accept(hit)) return hit;
    if (i >= maxFrames) return null;
    await tick();
  }
}

function blockName(id) {
  return getBlockDef(id).name;
}

function faceName(face) {
  return face >= 0 && face < FACE_NAMES.length ? FACE_NAMES[face] : 'inside';
}

/** renderer.getStats() or {} when unavailable / throwing. */
function safeStats(renderer) {
  if (!renderer || typeof renderer.getStats !== 'function') return EMPTY_STATS;
  try {
    return renderer.getStats() ?? EMPTY_STATS;
  } catch {
    return EMPTY_STATS;
  }
}

/**
 * Feet height for a standing spot in the cell column under world point (x, z): scan down from `fromY`
 * (+2 headroom) for the first y where block(y-1) is solid and blocks y, y+1 are not. Null when none.
 */
function findStandingHeight(getBlock, x, z, fromY) {
  const [q, r] = worldToHex(x, z);
  const top = Math.min(WORLD_HEIGHT - 2, Math.floor(fromY) + 2);
  for (let y = top; y >= 1; y--) {
    if (isSolid(getBlock(q, y - 1, r)) && !isSolid(getBlock(q, y, r)) && !isSolid(getBlock(q, y + 1, r))) return y;
  }
  return null;
}

/** 'webgl2' | 'webgl1' | 'none' | 'unknown' */
function detectWebGL(renderer, win) {
  const three = renderer && renderer.three;
  const glRenderer = three && three.renderer;
  if (!glRenderer || typeof glRenderer.getContext !== 'function') return 'none';
  let gl;
  try {
    gl = glRenderer.getContext();
  } catch {
    return 'none';
  }
  if (!gl) return 'none';
  const WebGL2 = (win && win.WebGL2RenderingContext) || globalThis.WebGL2RenderingContext;
  if (typeof WebGL2 === 'function' && gl instanceof WebGL2) return 'webgl2';
  const WebGL1 = (win && win.WebGLRenderingContext) || globalThis.WebGLRenderingContext;
  if (typeof WebGL1 === 'function' && gl instanceof WebGL1) return 'webgl1';
  return 'unknown';
}

/** Error messages captured so far for `win`, as strings. */
function collectErrors(win) {
  const handle = win && win.__caelancraft;
  const source = handle && Array.isArray(handle.errors) ? handle.errors : errorLogs.get(win) ?? [];
  const out = [];
  for (const e of source) out.push(typeof e === 'string' ? e : errMessage(e));
  return out;
}

/**
 * The smoke sequence proper. Only ever called from runSmokeTest, which converts a rejection into a FAIL step.
 * @param {GameContext} game
 * @param {Window|*} win
 * @param {ReturnType<typeof createSmokeState>} st
 */
async function runSmokeSequence(game, win, st) {
  const r = st.result;
  if (!game || typeof game !== 'object') {
    st.fail('no game context');
    return;
  }
  if (!win.__caelancraft || typeof win.__caelancraft !== 'object') installDebugHandle(win, game);
  const tick = makeTicker(game, win, r);

  // 1. Wait for main to reach 'playing'.
  let waited = 0;
  if (typeof game.getState === 'function') {
    while (game.getState() !== 'playing') {
      if (waited >= SMOKE_MAX_WAIT_PLAYING_FRAMES) {
        st.fail(`game never reached 'playing' (state '${game.getState()}' after ${waited} frames)`);
        return;
      }
      await tick();
      waited++;
    }
  }
  st.pass(`state 'playing' after ${waited} frames`);

  // v0.9 (§9.10): the sequence below is Creative's; a world opened in Survival (?mode=survival) switches first. The switch is
  // queued and applied at the top of the next frame.
  if (typeof game.getMode === 'function' && typeof game.setMode === 'function' && game.getMode() !== 'creative') {
    game.setMode('creative');
    for (let i = 0; i < SMOKE_MODE_FRAMES && game.getMode() !== 'creative'; i++) await tick();
    st.check(game.getMode() === 'creative', 'switched to Creative for the sequence', `still in ${game.getMode()} mode`);
  }

  const world = game.world;
  const player = game.player;
  const renderer = game.renderer;
  if (!world || !player) {
    st.fail('game context has no world or player');
    return;
  }

  // 2. Player must land within SMOKE_GROUND_FRAMES.
  let g = 0;
  while (!player.onGround && g < SMOKE_GROUND_FRAMES) {
    await tick();
    g++;
  }
  r.playerGrounded = player.onGround === true;
  st.check(
    r.playerGrounded,
    `player grounded after ${g} frames at (${fmt1(player.x)}, ${fmt1(player.y)}, ${fmt1(player.z)})`,
    `never grounded within ${SMOKE_GROUND_FRAMES} frames (y=${fmt1(player.y)} vy=${fmt1(player.vy)})`,
  );

  // 3. Chunks, meshes and draw calls.
  r.chunksLoaded = Number(world.chunkCount) || 0;
  const stats = safeStats(renderer);
  r.drawCalls = Number(stats.drawCalls) || 0;
  st.check(r.chunksLoaded > 0, `${r.chunksLoaded} chunks loaded`, 'world.chunkCount is 0');
  if (typeof stats.chunkMeshes === 'number') {
    st.check(stats.chunkMeshes > 0, `${stats.chunkMeshes} chunk meshes in the renderer`, 'renderer has 0 chunk meshes');
  }
  st.check(r.drawCalls > 0, `${r.drawCalls} draw calls, ${Number(stats.triangles) || 0} triangles`, 'renderer.getStats().drawCalls is 0');

  // 4–6. Look straight down, break the block under the player, put a block back in the hole.
  const yaw0 = game.controls && Number.isFinite(game.controls.yaw) ? game.controls.yaw : 0;
  game.setLook(yaw0, SMOKE_LOOK_DOWN_PITCH);
  // Hover during the round trip: otherwise gravity drops the player into the hole between the break and
  // the place, and the placement is (correctly) rejected because the player would intersect the block.
  player.flying = true;
  player.vy = 0;
  st.info('hovering (flying) during the break/place round trip');
  await tick();
  await tick(); // main refreshes its raycast with the new look direction

  const hit = await waitForHit(game, tick, (h) => h !== null, SMOKE_HIT_RETRY_FRAMES);
  if (!hit) {
    st.fail('no target block when looking straight down');
  } else {
    const hq = hit.q;
    const hy = hit.y;
    const hr = hit.r;
    const id = hit.blockId;
    st.pass(`target below: ${blockName(id)} cell (${hq}, ${hy}, ${hr}) face ${faceName(hit.face)}`);
    if (!isBreakable(id)) {
      st.fail(`target ${blockName(id)} is not breakable`);
    } else {
      const returned = game.breakTargeted();
      const after = world.getBlock(hq, hy, hr);
      const broke = returned === true && after === BLOCK.AIR;
      st.check(broke, 'breakTargeted() → true and the block is now AIR', `breakTargeted() returned ${returned}; block is now ${blockName(after)}`);

      if (broke) {
        let rm = 0;
        while (!world.isReadyAtCell(hq, hr) && rm < SMOKE_REMESH_FRAMES) {
          await tick();
          rm++;
        }
        st.check(world.isReadyAtCell(hq, hr), `chunk re-meshed after ${rm} frames`, `chunk not re-meshed within ${SMOKE_REMESH_FRAMES} frames`);

        game.setLook(yaw0, SMOKE_LOOK_DOWN_PITCH);
        await tick();
        const isNewTarget = (h) => h !== null && !(h.q === hq && h.y === hy && h.r === hr);
        const hit2 = await waitForHit(game, tick, isNewTarget, SMOKE_HIT_RETRY_FRAMES);
        if (!hit2) {
          st.fail('no target below the hole for placing');
        } else {
          const [tq, ty, tr] = faceNeighbor(hit2.q, hit2.y, hit2.r, hit2.face);
          // A mob may be in the way for a moment (a wary pig running through the hole: CONTRACTS §69): try for a few frames.
          let placedReturn = game.placeSelected();
          for (let f = 0; placedReturn !== true && f < SMOKE_HIT_RETRY_FRAMES; f++) {
            await tick();
            placedReturn = game.placeSelected();
          }
          const placedId = world.getBlock(tq, ty, tr);
          const placed = placedReturn === true && placedId !== BLOCK.AIR;
          r.breakPlaceRoundTrip = placed; // `broke` is already true on this path
          const where = tq === hq && ty === hy && tr === hr ? 'back in the hole' : `at cell (${tq}, ${ty}, ${tr}) next to the hole`;
          st.check(
            placed,
            `placeSelected() → ${blockName(placedId)} ${where}`,
            `placeSelected() returned ${placedReturn}; block at cell (${tq}, ${ty}, ${tr}) is ${blockName(placedId)}`,
          );
        }
      }
    }
  }
  player.flying = false;
  player.vy = 0;
  await tick();

  // 7. Spin a full turn.
  for (let i = 1; i <= SMOKE_SPIN_FRAMES; i++) {
    game.setLook(yaw0 + (Math.PI * 2 * i) / SMOKE_SPIN_FRAMES, 0);
    await tick();
  }
  game.setLook(yaw0, 0);
  st.pass(`rotated 360° over ${SMOKE_SPIN_FRAMES} frames`);

  // 8. Teleport forward 3 blocks (onto a standing spot in that column).
  const px = player.x;
  const pz = player.z;
  const [fx, fz] = yawToForward(yaw0);
  const tpx = px + fx * SMOKE_TELEPORT_DISTANCE;
  const tpz = pz + fz * SMOKE_TELEPORT_DISTANCE;
  const tpy = findStandingHeight(world.getBlock, tpx, tpz, player.y) ?? player.y;
  game.teleport(tpx, tpy, tpz);
  await tick();
  await tick();
  const moved = Math.hypot(player.x - px, player.z - pz);
  st.check(moved > 1, `teleported ${moved.toFixed(2)} blocks forward to (${fmt1(player.x)}, ${fmt1(player.y)}, ${fmt1(player.z)})`, `teleport did not move the player (moved ${moved.toFixed(2)})`);

  // 9. Fly up for SMOKE_FLY_FRAMES frames.
  const y0 = player.y;
  player.flying = true;
  for (let i = 0; i < SMOKE_FLY_FRAMES; i++) {
    player.vy = FLY_VERTICAL_SPEED;
    await tick();
  }
  player.vy = 0;
  st.check(player.y > y0 + 0.01, `flew up ${(player.y - y0).toFixed(2)} blocks in ${SMOKE_FLY_FRAMES} frames`, `y did not increase while flying (${fmt1(y0)} → ${fmt1(player.y)})`);

  // 9b. Rune Block round trip: place one by command, script it, run it, see its block appear, then clean up.
  if (typeof game.runCommand === 'function' && game.runes && typeof game.runes.set === 'function') {
    const help = game.runCommand('help');
    st.check(!!help && help.ok === true, 'console: help runs', `console: help failed (${help && help.message})`);
    const [fx2, fz2] = yawToForward(yaw0);
    const [rq, rr] = worldToHex(player.x + fx2 * 3, player.z + fz2 * 3);
    const standY = findStandingHeight(world.getBlock, player.x + fx2 * 3, player.z + fz2 * 3, player.y);
    if (standY === null) {
      st.info('rune round trip skipped (no standing spot ahead)');
    } else {
      const ry = standY - 1; // the solid surface cell of that column becomes the rune block
      const original = world.getBlock(rq, ry, rr);
      const placed = game.runCommand(`setblock ${rq} ${ry} ${rr} rune_block`);
      st.check(!!placed && placed.ok === true && world.getBlock(rq, ry, rr) === BLOCK.RUNE_BLOCK,
        `rune block placed by command at (${rq}, ${ry}, ${rr})`, `setblock rune_block failed: ${placed && placed.message}`);
      const rune = game.runes.set(rq, ry, rr, { script: 'setblock @ @1 @ stone\nsay smoke rune ran' });
      st.check(!!rune, 'rune script stored', 'rune store refused the script');
      const ran = game.runCommand(`run ${rq} ${ry} ${rr}`);
      st.check(!!ran && ran.ok === true, 'run command accepted', `run failed: ${ran && ran.message}`);
      let rt = 0;
      while (world.getBlock(rq, ry + 1, rr) !== BLOCK.STONE && rt < SMOKE_HIT_RETRY_FRAMES) {
        await tick();
        rt++;
      }
      st.check(world.getBlock(rq, ry + 1, rr) === BLOCK.STONE, `rune script placed stone above itself after ${rt} frames`, 'rune script did not place its block');
      st.check(game.runes.has(runeKey(rq, ry, rr)), 'rune entry survives its own run', 'rune entry vanished');
      game.runCommand(`setblock ${rq} ${ry + 1} ${rr} air`);
      const restored = game.runCommand(`setblock ${rq} ${ry} ${rr} ${original}`);
      st.check(!!restored && restored.ok === true && !game.runes.has(runeKey(rq, ry, rr)),
        'rune block replaced by command: entry removed', `cleanup failed: ${restored && restored.message}`);
    }
  } else {
    st.info('rune round trip skipped (no runCommand / runes on the game context)');
  }

  // 9c. v0.9 (§9.10): the optional survival step, only for a page opened with ?mode=survival.
  if (game.urlMode === 'survival') await runSurvivalSmoke(game, world, player, tick, st, yaw0);

  // 9d. v0.10 (DESIGN-circuits §6.7): the scenes, only for a page opened with ?scene=.
  if (game.urlScene === 'circuits') await runCircuitSceneSmoke(game, tick, st);
  else if (game.urlScene === 'vortex') await runVortexSceneSmoke(game, tick, st);

  // 10. WebGL2 context.
  r.webgl = detectWebGL(renderer, win);
  const hasWebGL2Type = typeof ((win && win.WebGL2RenderingContext) || globalThis.WebGL2RenderingContext) === 'function';
  if (r.webgl === 'webgl2') st.pass('WebGL2 context');
  else if (hasWebGL2Type) st.fail(`WebGL2 required, got '${r.webgl}'`);
  else st.info(`WebGL check skipped (no WebGL2RenderingContext in this environment; got '${r.webgl}')`);

  // 11. No captured errors.
  r.errors = collectErrors(win);
  st.check(r.errors.length === 0, 'no captured errors', `${r.errors.length} captured error(s): ${r.errors[0]}`);
}

/**
 * The survival smoke step (DESIGN-survival §9.10): back to Survival, `setblock ~ ~-1 ~ stone` and `pack add flint_pick`,
 * hold-dig the cell below for its break time (the real dig path, game.digTargeted) and see it become AIR with rock in the
 * pack, then `pack add honeyberries` and hold to eat one (game.useSelected).
 * @param {GameContext|*} game @param {*} world @param {*} player @param {() => Promise<void>} tick
 * @param {ReturnType<typeof createSmokeState>} st @param {number} yaw0
 */
async function runSurvivalSmoke(game, world, player, tick, st, yaw0) {
  if (typeof game.setMode !== 'function' || typeof game.digTargeted !== 'function' || !game.pack) {
    st.info('survival step skipped (no survival on the game context)');
    return;
  }
  game.setMode('survival');
  for (let i = 0; i < SMOKE_MODE_FRAMES && game.getMode() !== 'survival'; i++) await tick();
  if (!st.check(game.getMode() === 'survival', 'switched to Survival', `could not switch to Survival (mode ${game.getMode()})`)) return;
  let g = 0;
  while (!player.onGround && g < SMOKE_GROUND_FRAMES) {
    await tick();
    g++;
  }
  const placed = game.runCommand('setblock ~ ~-1 ~ stone');
  const added = game.runCommand('pack add flint_pick');
  st.check(!!placed && placed.ok && !!added && added.ok, 'stone below and a flint pick in the pack',
    `setup failed: ${placed && placed.message} / ${added && added.message}`);
  const pickSlot = game.pack.hotbarSlotOf('flint_pick');
  if (pickSlot >= 0) game.selectSlot(pickSlot);
  game.setLook(yaw0, SMOKE_LOOK_DOWN_PITCH);
  await tick();
  await tick();
  const hit = await waitForHit(game, tick, (h) => h !== null && h.blockId === BLOCK.STONE, SMOKE_HIT_RETRY_FRAMES);
  if (!st.check(!!hit, 'looking at the stone below', 'no stone below to dig')) return;
  const rockBefore = game.pack.count('rock');
  let dug = 0;
  for (; dug < SMOKE_DIG_FRAMES; dug++) {
    game.digTargeted(SMOKE_HEADLESS_DT);
    if (world.getBlock(hit.q, hit.y, hit.r) === BLOCK.AIR) break;
  }
  const broke = world.getBlock(hit.q, hit.y, hit.r) === BLOCK.AIR;
  // v0.10 (CONTRACTS §60): the rock flies to the player and enters the pack at the threshold — wait for it to arrive.
  for (let f = 0; broke && f < SMOKE_PICKUP_FRAMES && game.pack.count('rock') <= rockBefore; f++) await tick();
  st.check(broke && game.pack.count('rock') > rockBefore,
    `dug the stone with the flint pick in ${((dug + 1) * SMOKE_HEADLESS_DT).toFixed(2)} s; the pack holds ${game.pack.count('rock')} rock`,
    `hold-dig failed: block is ${blockName(world.getBlock(hit.q, hit.y, hit.r))}, rock ${game.pack.count('rock')}`);
  await tick();
  const food = game.runCommand('pack add honeyberries 2');
  const berrySlot = game.pack.hotbarSlotOf('honeyberries');
  if (!st.check(!!food && food.ok && berrySlot >= 0, 'honeyberries in the hotbar', `pack add honeyberries failed: ${food && food.message}`)) return;
  game.selectSlot(berrySlot);
  const before = game.pack.count('honeyberries');
  let held = 0;
  for (; held < SMOKE_EAT_FRAMES && game.pack.count('honeyberries') >= before; held++) game.useSelected(SMOKE_HEADLESS_DT);
  st.check(game.pack.count('honeyberries') === before - 1, `ate a honeyberry after holding ${((held + 1) * SMOKE_HEADLESS_DT).toFixed(2)} s`,
    `eating failed: ${game.pack.count('honeyberries')} of ${before} honeyberries left`);
}

/** Frames the vortex smoke runs the black holes for (3 s at 60 fps) and the doorbell smoke holds the button for. */
const SMOKE_VORTEX_FRAMES = 180;
const SMOKE_BELL_FRAMES = 30;

/**
 * The ?scene=circuits smoke step (DESIGN-circuits §6.7): build the worked examples, press the doorbell's button through the
 * game's circuits and see the bell ring.
 * @param {GameContext|*} game @param {() => Promise<void>} tick @param {ReturnType<typeof createSmokeState>} st
 */
async function runCircuitSceneSmoke(game, tick, st) {
  if (typeof game.buildScene !== 'function' || !game.circuits) {
    st.info('circuits scene skipped (no circuits on the game context)');
    return;
  }
  const scene = game.buildScene('circuits');
  const button = scene && scene.named ? scene.named['doorbell.button'] : null;
  const bell = scene && scene.named ? scene.named['doorbell.bell'] : null;
  if (!st.check(!!button && !!bell, 'the circuits scene is built', 'the circuits scene could not be built')) return;
  const c = game.circuits;
  const res = c.interact(button[0], button[1], button[2], 'use');
  st.check(!!res && res.ok, 'pressed the doorbell button', `the button did not press: ${res && res.message}`);
  let ringing = false;
  for (let i = 0; i < SMOKE_BELL_FRAMES && !ringing; i++) {
    c.hold(button[0], button[1], button[2]);
    await tick();
    const pr = c.probe(bell[0], bell[1], bell[2]);
    ringing = !!pr && pr.state === 'ringing';
  }
  const pr = c.probe(bell[0], bell[1], bell[2]);
  st.check(ringing, `the doorbell rings (${pr ? pr.volts : '?'} V)`, `the bell does not ring: ${pr ? `${pr.state}, ${pr.volts} V` : 'no probe'}`);
}

/**
 * The ?scene=vortex smoke step (DESIGN-circuits §6.7): set off a Collapsar Charge 8 cells ahead, run 3 s, and see exactly
 * one black hole.
 * @param {GameContext|*} game @param {() => Promise<void>} tick @param {ReturnType<typeof createSmokeState>} st
 */
async function runVortexSceneSmoke(game, tick, st) {
  if (typeof game.buildScene !== 'function' || !game.blackHoles) {
    st.info('vortex scene skipped (no black holes on the game context)');
    return;
  }
  const scene = game.buildScene('vortex');
  if (!st.check(!!scene && scene.ok, `set off a collapsar charge ahead${scene && scene.message ? `: ${scene.message}` : ''}`,
    `the vortex scene failed: ${scene && scene.message}`)) return;
  for (let i = 0; i < SMOKE_VORTEX_FRAMES; i++) await tick();
  st.check(game.blackHoles.size === 1, 'one black hole 3 s later', `${game.blackHoles.size} black holes 3 s later`);
}

/** First FAIL step text (without the prefix), or null. */
function firstFailure(result) {
  for (const s of result.steps) if (s.startsWith('FAIL ')) return s.slice(5);
  return null;
}

/** Publish a finished result: handle, console and DOM (each guarded — reporting must never throw). */
function reportSmokeResult(result, win) {
  const label = result.ok ? 'SMOKE_OK' : 'SMOKE_FAIL';
  let json;
  try {
    json = JSON.stringify(result);
  } catch {
    json = `{"done":true,"ok":${result.ok}}`;
  }
  try {
    if (win && win.__caelancraft && typeof win.__caelancraft === 'object') win.__caelancraft.smoke = result;
  } catch {
    /* frozen or exotic handle */
  }
  try {
    console.log(label, json);
  } catch {
    /* no console */
  }
  try {
    writeSmokeDom(win, result, label, json);
  } catch {
    /* no usable document */
  }
}

function writeSmokeDom(win, result, label, json) {
  const doc = win && win.document;
  if (!doc || !doc.body || typeof doc.createElement !== 'function') return;

  let el = doc.getElementById('smoke-result');
  if (!el) {
    el = doc.createElement('pre');
    el.id = 'smoke-result';
    if (el.style) el.style.cssText = SMOKE_RESULT_CSS;
    doc.body.appendChild(el);
  }
  el.textContent = json;
  el.setAttribute('data-status', label);
  el.setAttribute('data-ok', String(result.ok));

  let banner = doc.getElementById('smoke-banner');
  if (!banner) {
    banner = doc.createElement('div');
    banner.id = 'smoke-banner';
    doc.body.appendChild(banner);
  }
  if (banner.style) banner.style.cssText = `${SMOKE_BANNER_CSS}background:${result.ok ? SMOKE_OK_COLOR : SMOKE_FAIL_COLOR};`;
  banner.setAttribute('data-status', label);
  banner.textContent = result.ok
    ? `${label} — ${result.frames} frames, ${result.chunksLoaded} chunks, ${result.drawCalls} draw calls, ${result.webgl}`
    : `${label} — ${firstFailure(result) ?? 'see #smoke-result'}`;
}

/**
 * Run the in-page self-test (PLAN-build §4) once the game is playing. Resolves with the SmokeResult; never
 * rejects and never throws. Publishes the result to `win.__caelancraft.smoke`, `console.log('SMOKE_OK'|'SMOKE_FAIL', json)`,
 * `#smoke-result` (created under body if missing) and a fixed green/red `#smoke-banner`.
 * @param {GameContext} game
 * @param {Window|*} [win]
 * @returns {Promise<SmokeResult>}
 */
export function runSmokeTest(game, win = defaultWindow()) {
  return new Promise((resolve) => {
    const st = createSmokeState();
    const target = win && typeof win === 'object' ? win : defaultWindow();
    let finished = false;
    let watchdog = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (watchdog !== null) clearTimeout(watchdog);
      const result = st.finalize();
      reportSmokeResult(result, target);
      resolve(result);
    };
    watchdog = setTimeout(() => {
      st.fail(`timed out after ${SMOKE_WATCHDOG_MS / 1000} s (frames ${st.result.frames})`);
      finish();
    }, SMOKE_WATCHDOG_MS);

    let run;
    try {
      run = runSmokeSequence(game, target, st);
    } catch (err) {
      run = Promise.reject(err);
    }
    run.then(finish, (err) => {
      st.fail(`exception: ${errMessage(err)}`);
      finish();
    });
  });
}
