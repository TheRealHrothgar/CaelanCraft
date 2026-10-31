// Caelancraft — runtime diagnostics: URL parameters, error capture, the `window.__caelancraft` debug
// handle, the F3 overlay text and the in-page `?smoke=1` self-test.
// See src/CONTRACTS.md §22, docs/PLAN-build.md §3–§4 and docs/SPEC-gameplay.md §5.5.
//
// The DOM (window / document / location) is only touched inside functions and only through the `win`
// argument or guarded `typeof` checks, so this module also loads and runs under Node (tests, harness).
// The F3 day counter comes from game.getDay() (provided by main.js), falling back to stats.day / 1.
import { VERSION, WORLD_HEIGHT, FLY_VERTICAL_SPEED } from './config.js';
import { BLOCK, BIOME_NAMES, getBlockDef, isBreakable, isSolid } from './blocks.js';
import { worldToChunk, worldToLocal, lookDirection, yawToForward } from './coords.js';
import { FACE_NAMES, faceNeighbor, hexLength, worldToHex } from './hex.js';

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
  };
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
  const target = hit
    ? `${getBlockDef(hit.blockId).name} cell (${hit.q}, ${hit.y}, ${hit.r}) face ${faceName(hit.face)}`
    : 'none';

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
    `Mode: ${mode}`
  );
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
          const placedReturn = game.placeSelected();
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
