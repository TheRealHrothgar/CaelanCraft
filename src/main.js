// Caelancraft — main.js: boot, state machine and the game loop. See src/CONTRACTS.md §23.
//
// DOM glue. Nothing touches `window` / `document` at module top level: `boot()` runs only when both exist,
// so the module also imports cleanly under Node (the integration harness drives the pure modules directly).
//
// States: title → loading → clickToPlay → playing ⇄ paused, playing ⇄ picker.
// Every frame is one requestAnimationFrame callback: the simulation (input, physics, clock, streaming,
// raycast) runs only while `playing`; rendering, HUD and stats run in every state that has a player.
import {
  CHUNK_SIZE, RENDER_DISTANCE, LOADING_BUDGET_MS, REACH, BREAK_REPEAT_S, PLACE_REPEAT_S, MAX_FRAME_DT, FOV,
  SPRINT_FOV, START_TIME, AUTOSAVE_INTERVAL_S, HOTBAR_SIZE, VERSION, GAME_SECONDS_PER_DAY,
} from './config.js';
import { inHeightRange, yawToForward } from './coords.js';
import { faceNeighbor, hexDiscCount, hexLength, worldToHex } from './hex.js';
import {
  BLOCK, DEFAULT_HOTBAR, getBlockDef, isBreakable, isPlaceable, isReplaceable, isSolid,
} from './blocks.js';
import { normalizeSeed } from './noise.js';
import { World } from './world.js';
import { raycastHex } from './raycast.js';
import { createPlayer, stepPlayer, getEyeHeight, playerIntersectsBlock } from './physics.js';
import { advanceTime, computeSky, createSkyState } from './daynight.js';
import { saveGame, loadGame, clearSave, SAVE_VERSION } from './storage.js';
import { createAtlasCanvas, createAtlasTexture, makeSunCanvas, makeMoonCanvas } from './atlas.js';
import { createRenderer } from './renderer.js';
import { createControls } from './controls.js';
import { createHUD } from './hud.js';
import { createMenus } from './menus.js';
import { createAudio } from './audio.js';
import { RuneStore, RuneRunner, runeKey, SOURCE } from './runes.js';
import { createConsole } from './console.js';
import { createRuneEditor } from './runeEditor.js';
import {
  parseParams, installErrorCapture, installDebugHandle, updateDebugHandle, buildDebugText, runSmokeTest,
} from './diagnostics.js';

/** @typedef {import('./types.js').PlayerState} PlayerState */
/** @typedef {import('./types.js').RaycastHit} RaycastHit */
/** @typedef {import('./types.js').SaveData} SaveData */
/** @typedef {import('./types.js').GameContext} GameContext */

// ---------------------------------------------------------------------------------------------
// Constants (main-only tuning; everything shared lives in config.js)
// ---------------------------------------------------------------------------------------------

export const STATE = Object.freeze({
  TITLE: 'title',
  LOADING: 'loading',
  CLICK_TO_PLAY: 'clickToPlay',
  PLAYING: 'playing',
  PAUSED: 'paused',
  PICKER: 'picker',
  CONSOLE: 'console',
  EDITOR: 'editor',
});

/** Loading progress is reported over the hex disc of chunks within distance 2 of the spawn chunk (19 chunks). */
export const LOADING_RADIUS = 2;
export const LOADING_TOTAL = hexDiscCount(LOADING_RADIUS); // 19
/** KeyboardEvent.code of the hotbar keys, index = slot (precomputed: the loop runs every frame). */
const DIGIT_CODES = Object.freeze(Array.from({ length: HOTBAR_SIZE }, (_, i) => `Digit${i + 1}`));
/** Frames after which loading proceeds even if a chunk of the loading disc could not be meshed (never expected). */
const LOADING_MAX_FRAMES = 1800;
/** Sprint FOV eases 70 → 80 over this many seconds (SPEC-gameplay §4). */
export const FOV_EASE_S = 0.15;
/** Stats / debug handle refresh period. */
const STATS_INTERVAL_S = 0.25;
/** Player movement (blocks) that counts as "moved" for the autosave rule. */
const AUTOSAVE_MOVE_EPS = 1e-3;
const CANVAS_ID = 'game-canvas';
/** After closing a modal, pointer lock must be back within this long or the click-to-play overlay is shown. */
const RELOCK_CHECK_MS = 300;

// ---------------------------------------------------------------------------------------------
// Small pure helpers (exported for tests / reuse)
// ---------------------------------------------------------------------------------------------

/**
 * Seed for a new world: empty → random 31-bit integer, otherwise normalizeSeed(trimmed text).
 * @param {string|null|undefined} text
 * @param {() => number} [random]  [0,1) source (Math.random by default; injectable for tests)
 * @returns {number} uint32
 */
export function seedFromInput(text, random = Math.random) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed === '') return Math.floor(random() * 2 ** 31);
  return normalizeSeed(trimmed);
}

/**
 * Hotbar slot after `notches` wheel steps (+1 = scrolled down = next slot), wrapping.
 * @param {number} selected @param {number} notches
 */
export function wheelSlot(selected, notches) {
  const n = HOTBAR_SIZE;
  return ((((selected + notches) % n) + n) % n);
}

/**
 * Chunks the loading screen waits for: the hex disc of radius LOADING_RADIUS around the spawn chunk, shrunk
 * to the render ring when ?rd= is smaller (chunks outside the render distance are never meshed, so they
 * could never count as done).
 * @param {number} renderDistance
 * @returns {{ radius: number, total: number }}
 */
export function loadingRing(renderDistance) {
  const radius = Math.max(0, Math.min(LOADING_RADIUS, Math.floor(renderDistance)));
  return { radius, total: hexDiscCount(radius) };
}

/**
 * Move `fov` toward `target` at the sprint easing rate.
 * @param {number} fov @param {number} target @param {number} dt
 */
export function easeFov(fov, target, dt) {
  const rate = Math.abs(SPRINT_FOV - FOV) / FOV_EASE_S;
  const maxStep = rate * Math.max(0, dt);
  const diff = target - fov;
  if (Math.abs(diff) <= maxStep) return target;
  return fov + Math.sign(diff) * maxStep;
}

/** @returns {number[]} a valid 9-slot hotbar copy (falls back to DEFAULT_HOTBAR). */
function hotbarFrom(list) {
  if (Array.isArray(list) && list.length === HOTBAR_SIZE && list.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) {
    return list.slice();
  }
  return DEFAULT_HOTBAR.slice();
}

/** @returns {number} a valid slot index (0..8) or 0 */
function slotFrom(v) {
  return Number.isInteger(v) && v >= 0 && v < HOTBAR_SIZE ? v : 0;
}

/** Wrap a day fraction into [0,1); non-finite → START_TIME. */
function wrapTime(t) {
  if (!Number.isFinite(t)) return START_TIME;
  return t - Math.floor(t);
}

// ---------------------------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------------------------

/**
 * Create and start the game inside `win` / `doc`. Returns a handle with the GameContext and a `dispose()`.
 * Everything that can fail before the first frame (no WebGL, missing DOM ids) is reported to the error
 * banner and re-thrown so the failure is visible in the console too.
 * @param {Window} win
 * @param {Document} doc
 */
export function boot(win, doc) {
  const params = parseParams(win.location ? win.location.search : '');
  const autoplay = params.autoplay || params.smoke;

  // Errors are captured before anything else exists; the reporter falls back to the raw banner element
  // until the HUD has been created.
  /** @type {ReturnType<typeof createHUD>|null} */
  let hud = null;
  const rawBanner = doc.getElementById('error-banner');
  const reportError = (info) => {
    const message = info && typeof info === 'object' ? String(info.message) : String(info);
    if (hud) {
      hud.showError(message);
    } else if (rawBanner) {
      const line = doc.createElement('div');
      line.textContent = message;
      rawBanner.appendChild(line);
      rawBanner.classList.remove('hidden');
    }
  };
  const uninstallErrors = installErrorCapture(win, reportError);

  const canvas = /** @type {HTMLCanvasElement|null} */ (doc.getElementById(CANVAS_ID));
  if (!canvas) {
    reportError({ message: `Caelancraft: #${CANVAS_ID} not found` });
    throw new Error(`#${CANVAS_ID} not found`);
  }

  // ---- subsystems -----------------------------------------------------------------------------------
  let atlasCanvas;
  let renderer;
  let controls;
  let menus;
  let audio;
  /** @type {ReturnType<typeof createConsole>} */
  let consoleUI;
  /** @type {ReturnType<typeof createRuneEditor>} */
  let runeEditor;
  try {
    atlasCanvas = createAtlasCanvas();
    const atlasTexture = createAtlasTexture(atlasCanvas);
    renderer = createRenderer(canvas, atlasTexture, {
      sunCanvas: makeSunCanvas(),
      moonCanvas: makeMoonCanvas(),
      renderDistance: params.rd ?? RENDER_DISTANCE,
    });
    hud = createHUD(doc, atlasCanvas);
    controls = createControls(canvas, doc);
    audio = createAudio();
    consoleUI = createConsole(doc, {
      onLine: (line) => (runner ? runner.runConsoleLine(line) : { ok: false, message: 'no world is loaded' }),
      onClose: () => closeConsole(),
    });
    runeEditor = createRuneEditor(doc, {
      onChange: (key, partial) => {
        const rune = runeStore.get(key);
        if (!rune) return; // the block was removed while the editor was open
        const updated = runeStore.set(rune.q, rune.y, rune.r, partial);
        if (!updated) {
          hud.showSaveToast(`Too many rune blocks (max ${runeStore.max})`, true);
          return;
        }
        // The master switch behaves like `rune q y r off`: a running script of a disabled rune is cancelled.
        if (!updated.enabled && runner) runner.cancel(key);
      },
      onRun: (key) => {
        closeEditor();
        if (!runner) return;
        const res = runner.trigger(key, SOURCE.INTERACT);
        if (!res.ok) logLine(res.reason || 'could not run', true);
      },
      onClose: () => closeEditor(),
    });
  } catch (err) {
    reportError({ message: `Caelancraft failed to start: ${err && err.message ? err.message : err}` });
    throw err;
  }

  // ---- game state -----------------------------------------------------------------------------------
  let state = STATE.TITLE;
  /** @type {World|null} */
  let world = null;
  /** @type {PlayerState|null} */
  let player = null;
  /** @type {RaycastHit|null} */
  let hit = null;
  /** @type {SaveData|null} */
  let save = params.nosave ? null : loadGame();
  /** @type {SaveData|null} save being restored by the current loading step */
  let pendingSave = null;
  /** @type {number[]|null} [x, y, z] the loading screen streams around */
  let loadingCentre = null;
  let loadingFrames = 0;
  let loadingRadius = LOADING_RADIUS;
  let loadingTotal = LOADING_TOTAL;

  let time = START_TIME;
  let day = 1;
  let hotbar = DEFAULT_HOTBAR.slice();
  let selected = 0;

  let fov = FOV;
  let breakHeld = 0;
  let placeHeld = 0;

  let lastTs = NaN;
  let fpsFrames = 0;
  let fpsAccum = 0;
  let statsAccum = 0;
  const stats = {
    fps: 0,
    frameMs: 0,
    day: 1,
    state,
    chunksLoaded: 0,
    chunksDirty: 0,
    chunkMeshes: 0,
    meshesVisible: 0,
    triangles: 0,
    drawCalls: 0,
    geometries: 0,
  };

  // Rune Blocks: the store outlives worlds (replaceAll on load), the runner and command context are per world.
  const runeStore = new RuneStore();
  /** @type {RuneRunner|null} */
  let runner = null;
  /** @type {import('./commands.js').CommandContext|null} */
  let ctx = null;
  /** @type {string|null} rune key open in the editor */
  let editorKey = null;
  let savedRunesVersion = 0;

  let autosaveAccum = 0;
  let savedEditVersion = 0;
  let savedX = NaN;
  let savedY = NaN;
  let savedZ = NaN;

  let smokeStarted = false;
  let disposed = false;
  let rafId = 0;

  const sky = createSkyState();

  // ---- helpers --------------------------------------------------------------------------------------

  const hasSaveNow = () => !params.nosave && save !== null;

  /** Live raycast from the eye along the look direction (allocation-free apart from the hit object). */
  function updateHit() {
    if (!world || !player) {
      hit = null;
      return;
    }
    const yaw = controls.yaw;
    const pitch = controls.pitch;
    const cp = Math.cos(pitch);
    const dx = -Math.sin(yaw) * cp;
    const dy = Math.sin(pitch);
    const dz = -Math.cos(yaw) * cp;
    hit = raycastHex(world.getBlock, player.x, player.y + getEyeHeight(player), player.z, dx, dy, dz, REACH);
  }

  function selectSlot(i) {
    if (!Number.isInteger(i) || i < 0 || i >= HOTBAR_SIZE) return;
    selected = i;
    hud.setSelected(i);
    const id = hotbar[i];
    if (id !== BLOCK.AIR) hud.showBlockToast(getBlockDef(id).displayName);
  }

  /** Put `id` in `slot`, redraw the hotbar and toast the name. */
  function assignSlot(slot, id) {
    hotbar[slot] = id;
    hud.setHotbar(hotbar, selected);
    hud.showBlockToast(getBlockDef(id).displayName);
  }

  /** Console + HUD chat log line (command results, script errors, `say`). */
  function logLine(text, isError = false) {
    consoleUI.log(text, isError);
    hud.addChatLine(text, isError);
  }

  /** World.onBlockChange: keep the rune store in step with the cells that are (no longer) rune blocks. */
  function onBlockChanged(q, y, r, prev, next) {
    if (next === BLOCK.RUNE_BLOCK && prev !== BLOCK.RUNE_BLOCK) {
      runeStore.ensure(q, y, r);
    } else if (prev === BLOCK.RUNE_BLOCK && next !== BLOCK.RUNE_BLOCK) {
      const key = runeKey(q, y, r);
      if (runner) runner.cancel(key);
      runeStore.delete(key);
      if (state === STATE.EDITOR && editorKey === key) closeEditor();
    }
  }

  /** The CommandContext handed to the executor (CONTRACTS §26.3); built once the player exists. */
  function buildCommandContext() {
    /** @type {import('./commands.js').CommandContext} */
    const c = {
      world,
      player,
      controls,
      getTime: () => time,
      setTime: (t) => {
        time = wrapTime(t);
      },
      addTime: (gameSeconds) => {
        const nt = time + gameSeconds / GAME_SECONDS_PER_DAY;
        if (nt >= 1) day += Math.floor(nt);
        time = wrapTime(nt);
      },
      get timeFrozen() {
        return params.time != null;
      },
      get hotbar() {
        return hotbar;
      },
      get selected() {
        return selected;
      },
      setHotbarSlot: (slot, id) => assignSlot(slot, id),
      say: (text) => logLine(text),
      teleport: (x, y, z) => game.teleport(x, y, z),
      setFlying: (on) => {
        player.flying = !!on;
        player.vy = 0;
      },
      runes: runeStore,
      runner: /** @type {*} */ (null),
      rune: null,
      running: null,
      get seed() {
        return world.seed;
      },
    };
    return c;
  }

  /** Looking at a rune block: R runs it (if it has the Interact trigger). */
  function interactTarget() {
    const h = hit;
    if (!h || h.blockId !== BLOCK.RUNE_BLOCK || !runner) return;
    const rune = runeStore.ensure(h.q, h.y, h.r);
    if (rune && !rune.enabled) {
      logLine('this rune block is disabled — Shift+R to edit it');
      return;
    }
    if (rune && !rune.interact) {
      logLine('this rune block has no Interact trigger — Shift+R to edit it');
      return;
    }
    const res = runner.trigger(runeKey(h.q, h.y, h.r), SOURCE.INTERACT);
    if (!res.ok) logLine(res.reason || 'could not run', true);
  }

  /** Shift+R on a rune block: open its editor. */
  function editTarget() {
    const h = hit;
    if (!h || h.blockId !== BLOCK.RUNE_BLOCK) return;
    openEditorFor(h.q, h.y, h.r);
  }

  function openEditorFor(q, y, r) {
    openEditor(runeStore.ensure(q, y, r));
  }

  /** Text under the crosshair while a rune block is targeted. */
  function targetHintText() {
    const h = hit;
    if (!h || h.blockId !== BLOCK.RUNE_BLOCK) return null;
    const rune = runeStore.get(runeKey(h.q, h.y, h.r));
    const label = rune && rune.label ? `${rune.label} · ` : '';
    if (rune && !rune.enabled) return `${label}rune block (disabled) · Shift+R edit`;
    const canRun = !rune || rune.interact;
    return `${label}${canRun ? 'R run · ' : ''}Shift+R edit${canRun ? '' : ' (no Interact trigger)'}`;
  }

  /** Break rule (§23). @returns {boolean} */
  function breakTargeted() {
    if (!world || !player) return false;
    const h = hit;
    if (!h || !isBreakable(h.blockId)) return false;
    if (!world.setBlock(h.q, h.y, h.r, BLOCK.AIR)) return false;
    audio.playBreak(getBlockDef(h.blockId).soundGroup);
    updateHit();
    return true;
  }

  /** Place rule (§23). @returns {boolean} */
  function placeSelected() {
    if (!world || !player) return false;
    const h = hit;
    if (!h || h.face < 0) return false;
    const id = hotbar[selected];
    if (!isPlaceable(id)) return false;
    const [tq, ty, tr] = faceNeighbor(h.q, h.y, h.r, h.face);
    if (!inHeightRange(ty)) return false;
    if (!isReplaceable(world.getBlock(tq, ty, tr))) return false;
    if (isSolid(id) && playerIntersectsBlock(player, tq, ty, tr)) return false;
    if (!world.setBlock(tq, ty, tr, id)) return false;
    audio.playPlace(getBlockDef(id).soundGroup);
    updateHit();
    // A freshly placed rune block opens its editor right away (the onBlockChange hook created its entry).
    if (id === BLOCK.RUNE_BLOCK && state === STATE.PLAYING) openEditorFor(tq, ty, tr);
    return true;
  }

  /** Pick rule (middle mouse): select the slot holding the block, else assign it to the selected slot. */
  function pickTargeted() {
    const h = hit;
    if (!h || !isPlaceable(h.blockId)) return false;
    const i = hotbar.indexOf(h.blockId);
    if (i >= 0) selectSlot(i);
    else assignSlot(selected, h.blockId);
    audio.playClick();
    return true;
  }

  // ---- saving ---------------------------------------------------------------------------------------

  /** @returns {SaveData|null} */
  function buildSaveData() {
    if (!world || !player) return null;
    return {
      version: SAVE_VERSION,
      seed: world.seed,
      time,
      day,
      player: { x: player.x, y: player.y, z: player.z, yaw: controls.yaw, pitch: controls.pitch, flying: player.flying },
      hotbar: hotbar.slice(),
      selected,
      edits: world.exportEdits(),
      runes: runeStore.export(),
    };
  }

  /**
   * Save now. Skipped under ?nosave. Errors always show the red toast; `announce` also shows "World saved".
   * @param {boolean} announce
   * @returns {boolean}
   */
  function doSave(announce) {
    if (params.nosave) {
      if (announce) hud.showSaveToast('Saving disabled (?nosave=1)', true);
      return false;
    }
    const data = buildSaveData();
    if (!data) return false;
    const ok = saveGame(data);
    if (ok) {
      savedEditVersion = world.editVersion;
      savedRunesVersion = runeStore.version;
      savedX = player.x;
      savedY = player.y;
      savedZ = player.z;
      autosaveAccum = 0;
      save = data;
      if (announce) hud.showSaveToast('World saved');
    } else {
      hud.showSaveToast('Save failed: storage full', true);
    }
    return ok;
  }

  function playerMovedSinceSave() {
    return (
      Math.abs(player.x - savedX) > AUTOSAVE_MOVE_EPS ||
      Math.abs(player.y - savedY) > AUTOSAVE_MOVE_EPS ||
      Math.abs(player.z - savedZ) > AUTOSAVE_MOVE_EPS
    );
  }

  function autosaveTick(dt) {
    if (params.nosave) return;
    autosaveAccum += dt;
    if (autosaveAccum < AUTOSAVE_INTERVAL_S) return;
    autosaveAccum = 0;
    if (world.editVersion !== savedEditVersion || runeStore.version !== savedRunesVersion || playerMovedSinceSave()) doSave(false);
  }

  /** Save when the page is leaving / hidden while a world is live (any state with a player, click-to-play included). */
  function saveOnLeave() {
    if (!world || !player || state === STATE.TITLE || state === STATE.LOADING) return;
    // The editor pushes typing to the store after a debounce; flush it so the last keystrokes reach this save.
    if (runeEditor.isOpen()) {
      const key = runeEditor.getKey();
      const rune = key ? runeStore.get(key) : undefined;
      if (rune) runeStore.set(rune.q, rune.y, rune.r, runeEditor.getFields());
    }
    doSave(false);
  }

  // ---- state transitions ----------------------------------------------------------------------------

  function setState(s) {
    state = s;
    stats.state = s;
  }

  function showTitle() {
    setState(STATE.TITLE);
    controls.setEnabled(false);
    menus.hidePause();
    menus.hideLoading();
    menus.hideClickToPlay();
    menus.hidePicker();
    consoleUI.close();
    runeEditor.close();
    editorKey = null;
    hud.setPickerOpen(false);
    hud.setUnderwater(false);
    hud.setTargetHint(null);
    menus.showTitle(hasSaveNow());
    if (params.seed != null) {
      const el = doc.getElementById('seed-input');
      if (el) {
        el.value = String(params.seed);
        el.setAttribute('value', String(params.seed));
      }
    }
  }

  /**
   * Build the world and enter the loading screen.
   * @param {number} seed
   * @param {SaveData|null} restoring
   */
  function startLoading(seed, restoring) {
    if (world) {
      world.dispose();
      world = null;
    }
    player = null;
    hit = null;
    renderer.setHighlight(null);
    pendingSave = restoring;

    world = new World({ seed, renderDistance: params.rd ?? RENDER_DISTANCE, edits: restoring ? restoring.edits : undefined });
    world.onChunkMesh = (key, cq, cr, meshData) => renderer.setChunkMesh(key, cq, cr, meshData);
    world.onChunkUnload = (key) => renderer.removeChunkMesh(key);
    world.onBlockChange = onBlockChanged;
    // Runes: replace the store with the save's (validated) runes; nothing runs until the player exists.
    if (runner) runner.reset();
    runner = null;
    ctx = null;
    const runeWarnings = runeStore.replaceAll(restoring ? restoring.runes : null);
    for (const w of runeWarnings) console.warn('Caelancraft runes:', w);
    // After a WebGL context restore the renderer has dropped every chunk mesh (it keeps no CPU copy of the
    // vertex data). Flag the meshed chunks as never-meshed so the budgeted ring walk in world.update()
    // rebuilds them nearest-first over the next frames instead of all at once.
    renderer.onContextRestored = () => {
      if (!world) return;
      for (const c of world.chunks.values()) {
        if (c.meshed) {
          c.dirty = true;
          c.meshed = false;
        }
      }
    };
    renderer.setRenderDistance(world.renderDistance);

    time = restoring ? wrapTime(restoring.time) : START_TIME;
    if (params.time != null) time = params.time;
    day = restoring && Number.isFinite(restoring.day) ? Math.max(1, Math.floor(restoring.day)) : 1;
    hotbar = hotbarFrom(restoring ? restoring.hotbar : null);
    selected = slotFrom(restoring ? restoring.selected : 0);
    hud.setHotbar(hotbar, selected);

    const p = restoring ? restoring.player : null;
    loadingCentre = p ? [p.x, p.y, p.z] : world.findSpawn();
    loadingFrames = 0;
    ({ radius: loadingRadius, total: loadingTotal } = loadingRing(world.renderDistance));

    controls.setEnabled(false);
    menus.hideTitle();
    menus.hideClickToPlay();
    menus.hidePause();
    menus.showLoading(0, loadingTotal);
    setState(STATE.LOADING);
  }

  /** @returns {number} meshed chunks within hex distance loadingRadius of the loading centre's chunk */
  function loadingProgress() {
    const [q, r] = worldToHex(loadingCentre[0], loadingCentre[2]);
    const cq = Math.floor(q / CHUNK_SIZE);
    const cr = Math.floor(r / CHUNK_SIZE);
    let done = 0;
    for (let dq = -loadingRadius; dq <= loadingRadius; dq++) {
      for (let dr = -loadingRadius; dr <= loadingRadius; dr++) {
        if (hexLength(dq, dr) > loadingRadius) continue;
        const c = world.getChunk(cq + dq, cr + dr);
        if (c && c.meshed && !c.dirty) done++;
      }
    }
    return done;
  }

  function stepLoading() {
    const [sx, , sz] = loadingCentre;
    // Spend up to LOADING_BUDGET_MS per frame; update() itself caps at MAX_BUILDS_PER_UPDATE per call.
    const start = now();
    let r;
    do {
      r = world.update(sx, sz, LOADING_BUDGET_MS - (now() - start));
    } while ((r.pendingGen > 0 || r.pendingMesh > 0) && now() - start < LOADING_BUDGET_MS);
    loadingFrames++;

    const done = loadingProgress();
    menus.showLoading(done, loadingTotal);
    // Contract: ready when the spawn chunk is meshed. We additionally wait for the loading disc the progress
    // bar promises (or a generous frame cap) so the player never spawns looking at holes.
    const ringDone = done >= loadingTotal || (r.pendingGen === 0 && r.pendingMesh === 0) || loadingFrames >= LOADING_MAX_FRAMES;
    if (world.isReadyAt(sx, sz) && ringDone) finishLoading();
  }

  function finishLoading() {
    const restoring = pendingSave;
    pendingSave = null;
    const [sx, sy, sz] = loadingCentre;
    player = createPlayer(sx, sy, sz);
    if (restoring && restoring.player) {
      player.flying = Boolean(restoring.player.flying);
      controls.yaw = restoring.player.yaw;
      controls.pitch = restoring.player.pitch;
    } else {
      controls.yaw = Math.PI; // face +Z
      controls.pitch = 0;
    }
    // Debug/screenshot aids: ?yaw= and ?pitch= (degrees) override the initial look direction.
    if (params.yaw != null) controls.yaw = (params.yaw * Math.PI) / 180;
    if (params.pitch != null) controls.pitch = (params.pitch * Math.PI) / 180;
    if (params.fly) player.flying = true;

    ctx = buildCommandContext();
    runner = new RuneRunner(runeStore, ctx);
    ctx.runner = runner;
    runner.onLog = (line, isError) => logLine(line, isError);
    runner.onTrigger = (_key, source) => {
      if (source === SOURCE.INTERACT || source === SOURCE.STEP) audio.playClick();
    };
    runner.seedStep();

    savedEditVersion = world.editVersion;
    savedRunesVersion = runeStore.version;
    savedX = player.x;
    savedY = player.y;
    savedZ = player.z;
    autosaveAccum = 0;
    fov = FOV;
    breakHeld = 0;
    placeHeld = 0;
    updateHit();

    menus.hideLoading();
    if (autoplay) {
      enterPlaying();
      showDebugUi();
    } else {
      setState(STATE.CLICK_TO_PLAY);
      menus.showClickToPlay();
    }
  }

  /** `?ui=console|editor` with autoplay: open the console, or place a rune block three cells ahead and open its editor (screenshots). */
  function showDebugUi() {
    if (!params.ui || !runner || !player || params.smoke) return; // a modal would stall the smoke sequence
    if (params.ui === 'console') {
      openConsole('');
      consoleUI.log(runner.runConsoleLine('help').message);
      return;
    }
    const [fx, fz] = yawToForward(controls.yaw);
    const [q, r] = worldToHex(player.x + fx * 3, player.z + fz * 3);
    const y = Math.max(0, Math.floor(player.y) - 1);
    runner.runConsoleLine(`setblock ${q} ${y} ${r} rune_block`);
    const rune = runeStore.set(q, y, r, { label: 'lift', script: '# runs on R\nsay Going up\nhexring @ @1 @ 2 3 stone_bricks\nwait 1\ntp @ @4 @', stepOn: true, chain: true });
    if (rune) openEditor(rune);
  }

  function enterPlaying() {
    menus.hideClickToPlay();
    menus.hidePause();
    setState(STATE.PLAYING);
    controls.setEnabled(true);
    controls.lock();
    audio.resume();
    if (params.smoke && !smokeStarted) {
      smokeStarted = true;
      runSmokeTest(game, win);
    }
  }

  function pause() {
    if (state !== STATE.PLAYING) return;
    setState(STATE.PAUSED);
    controls.setEnabled(false);
    controls.unlock();
    menus.showPause(world.seed);
    doSave(false);
  }

  function resume() {
    if (state !== STATE.PAUSED) return;
    enterPlaying();
  }

  function openPicker() {
    if (state !== STATE.PLAYING) return;
    setState(STATE.PICKER); // before unlock(): the lock-change handler must not read 'playing'
    controls.setEnabled(false);
    controls.unlock();
    hud.setPickerOpen(true);
    menus.showPicker(hotbar, selected);
    breakHeld = 0;
    placeHeld = 0;
  }

  function closePicker() {
    if (state !== STATE.PICKER) return;
    menus.hidePicker();
    hud.setPickerOpen(false);
    enterPlayingFromModal();
  }

  /**
   * Leave a modal (picker / console / editor). Esc is not a user-activation event, so the pointer lock request
   * can be refused; if it is not back shortly, fall into click-to-play instead of a dead "playing" state.
   */
  function enterPlayingFromModal() {
    enterPlaying();
    win.setTimeout(() => {
      if (disposed || state !== STATE.PLAYING || controls.locked) return;
      setState(STATE.CLICK_TO_PLAY);
      controls.setEnabled(false);
      doSave(false); // like pause(): the overlay may sit there for a long time
      menus.showClickToPlay();
    }, RELOCK_CHECK_MS);
  }

  function openConsole(prefill) {
    if (state !== STATE.PLAYING) return;
    setState(STATE.CONSOLE); // before unlock(): the lock-change handler must not read 'playing'
    controls.setEnabled(false);
    controls.unlock();
    consoleUI.open(prefill);
    breakHeld = 0;
    placeHeld = 0;
  }

  function closeConsole() {
    if (state !== STATE.CONSOLE) return;
    consoleUI.close();
    enterPlayingFromModal();
  }

  /** @param {import('./types.js').Rune} rune */
  function openEditor(rune) {
    if (state !== STATE.PLAYING || !rune) return;
    editorKey = rune.key;
    setState(STATE.EDITOR);
    controls.setEnabled(false);
    controls.unlock();
    runeEditor.open(rune, runner ? runner.getLastRun(rune.key) : null);
    breakHeld = 0;
    placeHeld = 0;
  }

  function closeEditor() {
    if (state !== STATE.EDITOR) return;
    runeEditor.close();
    editorKey = null;
    enterPlayingFromModal();
  }

  function quitToTitle() {
    doSave(false);
    if (runner) runner.reset();
    runner = null;
    ctx = null;
    runeStore.clear();
    if (world) {
      world.dispose();
      world = null;
    }
    player = null;
    hit = null;
    renderer.setHighlight(null);
    if (!params.nosave) save = loadGame();
    showTitle();
  }

  // ---- menus / hud callbacks ------------------------------------------------------------------------

  menus = createMenus(doc, atlasCanvas, {
    onNewWorld(seedText) {
      if (state !== STATE.TITLE) return;
      const seed = seedFromInput(seedText);
      if (!params.nosave) clearSave();
      save = null;
      audio.resume();
      startLoading(seed, null);
    },
    onContinue() {
      if (state !== STATE.TITLE) return;
      save = params.nosave ? null : loadGame();
      if (!save) {
        menus.showTitle(false);
        return;
      }
      audio.resume();
      startLoading(save.seed, save);
    },
    onClickToPlay() {
      if (state !== STATE.CLICK_TO_PLAY) return;
      enterPlaying();
    },
    onResume() {
      resume();
    },
    onSave() {
      if (state !== STATE.PAUSED) return;
      doSave(true);
    },
    onStopRunes() {
      if (!runner) return;
      const n = runner.stopAll();
      hud.showSaveToast(`Stopped ${n} rune script${n === 1 ? '' : 's'}; triggers paused`);
      logLine(`stopall: stopped ${n} script${n === 1 ? '' : 's'}; rune triggers paused (press R on a rune or run resume)`);
    },
    onQuit() {
      if (state !== STATE.PAUSED) return;
      quitToTitle();
    },
    onPickBlock(blockId, slot) {
      if (state !== STATE.PICKER || !isPlaceable(blockId)) return;
      if (slot === null || slot === undefined) {
        assignSlot(selected, blockId);
        audio.playClick();
        closePicker();
      } else if (Number.isInteger(slot) && slot >= 0 && slot < HOTBAR_SIZE) {
        // Digit while hovering: assign and stay open. (Not re-calling showPicker on purpose: it would clear
        // the hover state, so a second digit press without moving the mouse would be ignored.)
        assignSlot(slot, blockId);
        audio.playClick();
      }
    },
    onPickerClose() {
      closePicker();
    },
  });

  hud.onSlotClick = (slot) => {
    if (state !== STATE.PICKER) return;
    if (!Number.isInteger(slot) || slot < 0 || slot >= HOTBAR_SIZE) return;
    selected = slot;
    hud.setSelected(slot);
    menus.showPicker(hotbar, selected);
  };

  controls.onLockChange = (locked) => {
    if (!locked) {
      if (state === STATE.PLAYING) pause();
    } else if (state === STATE.PAUSED) {
      // Lock re-acquired (e.g. a click that slipped past the menu): treat as resume.
      resume();
    } else if (state === STATE.CLICK_TO_PLAY && player) {
      // A lock requested while closing a modal can arrive after the relock fallback showed the overlay.
      enterPlaying();
    }
  };

  // Clicking the canvas while playing without the lock (a failed/expired request) re-requests it.
  const onCanvasMouseDown = () => {
    if (state === STATE.PLAYING && !controls.locked) controls.lock();
  };
  canvas.addEventListener('mousedown', onCanvasMouseDown);

  // ---- game context for diagnostics -----------------------------------------------------------------

  /** @type {GameContext & { getDay: () => number, dispose: () => void }} */
  const game = {
    get world() {
      return world;
    },
    get player() {
      return player;
    },
    controls,
    renderer,
    hud,
    getTime: () => time,
    setTime(t) {
      if (Number.isFinite(t)) time = wrapTime(t);
    },
    getDay: () => day,
    getHit: () => hit,
    breakTargeted,
    placeSelected,
    teleport(x, y, z) {
      if (!player || !Number.isFinite(x + y + z)) return;
      player.x = x;
      player.y = y;
      player.z = z;
      player.vx = 0;
      player.vy = 0;
      player.vz = 0;
      player.onGround = false;
      if (world) world.update(x, z);
      if (runner) runner.seedStep(); // arriving by teleport is not stepping onto a rune
      updateHit();
    },
    setLook(yaw, pitch) {
      if (Number.isFinite(yaw)) controls.yaw = yaw;
      if (Number.isFinite(pitch)) controls.pitch = pitch;
      updateHit();
    },
    getState: () => state,
    stepFrame: (dt) => stepFrame(dt),
    runCommand: (line) => (runner ? runner.runConsoleLine(line) : null),
    get runes() {
      return runeStore;
    },
    get runner() {
      return runner;
    },
    dispose,
  };

  installDebugHandle(win, game);

  // ---- per-frame work -------------------------------------------------------------------------------

  function now() {
    return typeof win.performance !== 'undefined' && typeof win.performance.now === 'function'
      ? win.performance.now()
      : Date.now();
  }

  /** Input, interaction, physics, clock, streaming and raycast — only while playing. */
  function stepPlaying(dt) {
    const input = controls.getInput();

    if (controls.consumeFlyToggle()) {
      player.flying = !player.flying;
      player.vy = 0;
    }
    // Modal keys first, so a key that opens a modal never also acts on the hotbar in the same frame.
    if (controls.consumePressed('KeyE')) {
      openPicker();
      return; // the picker frame still renders below
    }
    if (controls.consumePressed('KeyT')) {
      openConsole('');
      return;
    }
    if (controls.consumePressed('Slash')) {
      openConsole('/');
      return;
    }
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      if (controls.consumePressed(DIGIT_CODES[i])) selectSlot(i);
    }
    if (controls.consumePressed('F3')) hud.toggleDebug();
    if (controls.consumePressed('KeyM')) hud.showSaveToast(audio.toggleMuted() ? 'Sound muted' : 'Sound on');

    const mouse = controls.consumeMouse();
    if (mouse.wheel !== 0) selectSlot(wheelSlot(selected, mouse.wheel));

    if (controls.consumePressed('KeyR')) {
      if (controls.isDown('ShiftLeft') || controls.isDown('ShiftRight')) {
        editTarget();
        if (state !== STATE.PLAYING) return;
      } else {
        interactTarget();
      }
    }

    // Interaction uses the hit computed at the end of the previous frame (what the highlight showed).
    if (mouse.leftPressed) {
      breakTargeted();
      breakHeld = 0;
    } else if (mouse.left) {
      breakHeld += dt;
      if (breakHeld >= BREAK_REPEAT_S) {
        breakHeld -= BREAK_REPEAT_S;
        breakTargeted();
      }
    } else {
      breakHeld = 0;
    }
    if (mouse.rightPressed) {
      placeSelected();
      placeHeld = 0;
    } else if (mouse.right) {
      placeHeld += dt;
      if (placeHeld >= PLACE_REPEAT_S) {
        placeHeld -= PLACE_REPEAT_S;
        placeSelected();
      }
    } else {
      placeHeld = 0;
    }
    if (mouse.middlePressed) pickTargeted();

    // Physics only where terrain exists (getBlock reports AIR in unloaded chunks).
    if (world.hasChunkAt(player.x, player.z)) stepPlayer(player, input, world.getBlock, dt);

    if (params.time == null) {
      const nt = advanceTime(time, dt);
      if (nt < time) day++;
      time = nt;
    }

    // Rune scripts run after physics (step-on sees where the player landed) and before world.update() so their
    // edits are re-meshed this frame. A modal opened by a script (none today) would stop the loop next frame.
    if (runner && state === STATE.PLAYING) runner.update(dt);

    world.update(player.x, player.z);
    updateHit();
    autosaveTick(dt);
  }

  /** Camera, sky, highlight, HUD and the draw — every state that has a player. */
  function renderFrame(dt) {
    const eyeY = player.y + getEyeHeight(player);
    renderer.setCamera(player.x, eyeY, player.z, controls.yaw, controls.pitch);
    fov = easeFov(fov, player.sprinting && state === STATE.PLAYING ? SPRINT_FOV : FOV, dt);
    renderer.setFov(fov);
    renderer.setHighlight(hit);
    computeSky(time, sky);
    renderer.setSky(sky);
    renderer.setUnderwater(player.headInWater);
    hud.setUnderwater(player.headInWater);
    hud.setTargetHint(state === STATE.PLAYING ? targetHintText() : null);
    if (hud.isDebugVisible()) hud.setDebugText(buildDebugText(game, stats));
    renderer.render();
  }

  function refreshStats(rawDt) {
    fpsFrames++;
    fpsAccum += rawDt;
    if (fpsAccum >= 1) {
      stats.fps = fpsFrames / fpsAccum;
      stats.frameMs = (fpsAccum * 1000) / fpsFrames;
      fpsFrames = 0;
      fpsAccum = 0;
    }
    statsAccum += rawDt;
    if (statsAccum < STATS_INTERVAL_S) return;
    statsAccum = 0;
    stats.day = day;
    if (world) {
      stats.chunksLoaded = world.chunkCount;
      let dirty = 0;
      for (const c of world.chunks.values()) if (c.dirty && c.meshed) dirty++;
      stats.chunksDirty = dirty;
    } else {
      stats.chunksLoaded = 0;
      stats.chunksDirty = 0;
    }
    const rs = renderer.getStats();
    stats.chunkMeshes = rs.chunkMeshes;
    stats.meshesVisible = rs.chunkMeshes;
    stats.triangles = rs.triangles;
    stats.drawCalls = rs.drawCalls;
    stats.geometries = rs.geometries;
    if (player) updateDebugHandle(win, stats);
  }

  function frame(ts) {
    if (disposed) return;
    rafId = win.requestAnimationFrame(frame); // schedule first so an exception cannot stop the loop
    const t = Number.isFinite(ts) ? ts : now();
    const rawDt = Number.isFinite(lastTs) ? Math.max(0, (t - lastTs) / 1000) : 0;
    lastTs = t;
    stepFrame(rawDt);
  }

  /**
   * One simulation + render step of `rawDt` seconds (clamped to MAX_FRAME_DT). Called by the rAF loop
   * and, via `game.stepFrame`, by the smoke test when rAF is starved (headless Chrome under a
   * virtual-time budget only delivers a handful of animation frames while timers race ahead).
   * @param {number} rawDt
   */
  function stepFrame(rawDt) {
    if (disposed) return;
    const dt = Math.min(Math.max(0, Number.isFinite(rawDt) ? rawDt : 0), MAX_FRAME_DT);

    switch (state) {
      case STATE.LOADING:
        stepLoading();
        break;
      case STATE.PLAYING:
        stepPlaying(dt);
        break;
      default:
        break; // title / clickToPlay / paused / picker: frozen simulation
    }
    if (player) renderFrame(dt);
    refreshStats(rawDt);
  }

  // ---- window events --------------------------------------------------------------------------------

  const onResize = () => renderer.resize(win.innerWidth, win.innerHeight);
  const onPageHide = () => saveOnLeave();
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') saveOnLeave();
  };
  win.addEventListener('resize', onResize);
  win.addEventListener('pagehide', onPageHide);
  win.addEventListener('beforeunload', onPageHide);
  doc.addEventListener('visibilitychange', onVisibility);

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (rafId) win.cancelAnimationFrame(rafId);
    win.removeEventListener('resize', onResize);
    win.removeEventListener('pagehide', onPageHide);
    win.removeEventListener('beforeunload', onPageHide);
    doc.removeEventListener('visibilitychange', onVisibility);
    canvas.removeEventListener('mousedown', onCanvasMouseDown);
    uninstallErrors();
    if (runner) runner.reset();
    runner = null;
    runeStore.clear();
    if (world) world.dispose();
    world = null;
    player = null;
    controls.dispose();
    hud.dispose();
    menus.dispose();
    consoleUI.dispose();
    runeEditor.dispose();
    renderer.dispose();
  }

  // ---- go -------------------------------------------------------------------------------------------

  onResize();
  hud.setHotbar(hotbar, selected);
  if (params.debug) hud.setDebugVisible(true);

  if (autoplay) {
    // Skip the title: ?seed wins, then the save's seed (whose edits we restore), then a random seed.
    let restoring = null;
    let seed;
    if (params.seed != null) {
      seed = normalizeSeed(params.seed);
      if (save && save.seed === seed) {
        restoring = save;
      } else if (save && !params.nosave) {
        // A debugging URL must never clobber the player's saved world: run this seed without saving.
        params.nosave = true;
        console.warn('Caelancraft: ?autoplay with a different ?seed than the saved world — saving disabled for this session.');
      }
    } else if (save) {
      seed = save.seed;
      restoring = save;
    } else {
      seed = seedFromInput('');
    }
    startLoading(seed, restoring);
  } else {
    showTitle();
  }

  rafId = win.requestAnimationFrame(frame);
  console.log(`Caelancraft v${VERSION}`);
  return game;
}

// Browser entry point. Under Node (tests, import checks) neither global exists and nothing runs.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  boot(window, document);
}
