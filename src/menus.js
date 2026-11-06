// Caelancraft — title / loading / click-to-play / pause / block-picker screens.
// See src/CONTRACTS.md §20 and docs/SPEC-gameplay.md §5.1–§5.5.
//
// DOM module. Every DOM access goes through the `doc` handed to createMenus and happens inside a
// function, so this file can be imported in Node. Imports: config, blocks, atlas (per the import graph).
import { HOTBAR_SIZE } from './config.js';
import { TILE, PICKER_ORDER, getBlockDef } from './blocks.js';
import { makeBlockIconCanvas, makeTiledBackgroundDataURL, drawTitleLogo } from './atlas.js';

/** The 18 title-screen splash strings from docs/SPEC-gameplay.md §5.4, verbatim. */
export const SPLASHES = Object.freeze([
  'Caelan approved!',
  'Hand-crafted by Caelan!',
  'Caelan was here',
  'Caelancraft: now in 3D!',
  'Now with 100% more hexagons!',
  'Zero textures downloaded!',
  'Procedurally generated!',
  "Don't dig straight down!",
  'Diamonds are down there somewhere',
  'Infinite* (*until your RAM runs out)',
  'Powered by Three.js!',
  'Punch trees!',
  'Also try sleeping!',
  'Built in a browser!',
  'Double-tap space to fly!',
  'No creepers were harmed',
  'Shift to sneak, E for blocks',
  "It's a feature!",
]);

/**
 * Controls cheat-sheet rows (docs/SPEC-gameplay.md §4), rendered as one `<kbd>` + one `<span>` per row
 * into the two-column `.controls-sheet` grids (#title-controls, #pause-controls).
 * @type {ReadonlyArray<readonly [string, string]>}
 */
export const CONTROLS_SHEET = Object.freeze([
  Object.freeze(['W A S D', 'Move (arrow keys work too)']),
  Object.freeze(['Mouse', 'Look around']),
  Object.freeze(['Space', 'Jump · fly up']),
  Object.freeze(['Shift', 'Sneak · fly down']),
  Object.freeze(['W W', 'Double-tap: sprint (while W is held)']),
  Object.freeze(['Space Space', 'Double-tap: toggle fly (or F)']),
  Object.freeze(['LMB', 'Break block (hold to repeat)']),
  Object.freeze(['RMB', 'Place block (hold to repeat)']),
  Object.freeze(['MMB', 'Pick the targeted block into the hotbar']),
  Object.freeze(['1–9', 'Select hotbar slot (or scroll wheel)']),
  Object.freeze(['E', 'Open / close the block picker']),
  Object.freeze(['T  /', 'Command console (/ starts a command)']),
  Object.freeze(['R', 'Run the targeted Rune Block']),
  Object.freeze(['Shift R', 'Edit the targeted Rune Block (also opens on placing one)']),
  Object.freeze(['Esc', 'Pause · close menus']),
  Object.freeze(['F3', 'Toggle the debug overlay']),
  Object.freeze(['M', 'Mute / unmute sound']),
]);

/** Text of the confirm() shown when New World would overwrite an existing save (CONTRACTS §20). */
export const CONFIRM_NEW_WORLD_TEXT = 'This will delete your saved world. Continue?';

/** Edge length of the block-picker icon canvases, in CSS pixels (CONTRACTS §20). */
export const PICKER_ICON_PX = 64;

/** `#picker-name` content while nothing is hovered: a non-breaking space keeps the line's height. */
const PICKER_NAME_IDLE = ' ';

/** Element ids in index.html this module binds to (property name → id). */
const IDS = Object.freeze({
  titleScreen: 'title-screen',
  titleLogo: 'title-logo',
  splashText: 'splash-text',
  seedInput: 'seed-input',
  btnNewWorld: 'btn-new-world',
  btnContinue: 'btn-continue',
  titleControls: 'title-controls',
  loadingScreen: 'loading-screen',
  loadingBar: 'loading-bar',
  loadingText: 'loading-text',
  clickToPlay: 'click-to-play',
  pauseMenu: 'pause-menu',
  btnResume: 'btn-resume',
  btnSave: 'btn-save',
  btnStopRunes: 'btn-stop-runes',
  btnQuit: 'btn-quit',
  pauseSeed: 'pause-seed',
  pauseControls: 'pause-controls',
  blockPicker: 'block-picker',
  pickerGrid: 'picker-grid',
  pickerName: 'picker-name',
});

/**
 * @typedef {Object} MenusCallbacks  All optional; missing callbacks are simply not fired.
 * @property {(seedText: string) => void} [onNewWorld]   text of #seed-input (untrimmed; main normalises)
 * @property {() => void} [onContinue]
 * @property {() => void} [onResume]
 * @property {() => void} [onSave]
 * @property {() => void} [onStopRunes]   pause-menu "Stop All Rune Scripts"
 * @property {() => void} [onQuit]
 * @property {() => void} [onClickToPlay]
 * @property {(blockId: number, slot: number|null) => void} [onPickBlock]  slot 0..8 for Digit1-9, null for a click
 * @property {() => void} [onPickerClose]
 */

/**
 * @typedef {Object} Menus
 * @property {(hasSave: boolean) => void} showTitle
 * @property {() => void} hideTitle
 * @property {(done: number, total: number) => void} showLoading
 * @property {() => void} hideLoading
 * @property {() => void} showClickToPlay
 * @property {() => void} hideClickToPlay
 * @property {(seed: number|string) => void} showPause
 * @property {() => void} hidePause
 * @property {(hotbar: number[], selected: number) => void} showPicker
 * @property {() => void} hidePicker
 * @property {() => boolean} isPickerOpen
 * @property {() => string} getSeedInput
 * @property {() => void} dispose
 */

/**
 * Look up every element in `IDS`; fail fast with one clear message listing everything that is missing.
 * The markup is static and owned by index.html, so a missing id is a build error, not a runtime condition.
 * @param {Document} doc
 * @returns {Record<keyof typeof IDS, HTMLElement>}
 */
function bindElements(doc) {
  /** @type {Record<string, HTMLElement>} */
  const out = {};
  const missing = [];
  for (const name of Object.keys(IDS)) {
    const id = IDS[/** @type {keyof typeof IDS} */ (name)];
    const el = doc.getElementById(id);
    if (el) out[name] = el;
    else missing.push('#' + id);
  }
  if (missing.length) throw new Error(`menus: missing DOM element(s): ${missing.join(', ')}`);
  return /** @type {Record<keyof typeof IDS, HTMLElement>} */ (out);
}

/** Remove every child of `el` (works on every DOM implementation, unlike replaceChildren). */
function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/**
 * Map a KeyboardEvent.key to the KeyboardEvent.code this module cares about, for events that carry no
 * `code` (some synthetic / virtual-keyboard events). Returns '' when the key is not one we handle.
 * @param {string|undefined} key
 */
function codeFromKey(key) {
  if (key === 'Escape' || key === 'Esc') return 'Escape';
  if (key === 'e' || key === 'E') return 'KeyE';
  if (typeof key === 'string' && key.length === 1 && key >= '1' && key <= '9') return 'Digit' + key;
  return '';
}

/**
 * Hotbar slot (0-based) selected by a `Digit1`..`Digit9` code, or -1 for anything else / out of range.
 * @param {string} code
 */
function slotFromDigitCode(code) {
  if (!code.startsWith('Digit')) return -1;
  const n = Number(code.slice(5));
  return Number.isInteger(n) && n >= 1 && n <= HOTBAR_SIZE ? n - 1 : -1;
}

/**
 * Create the menu controller bound to the ids in index.html.
 *
 * Decorative atlas work (dirt background, logo, picker icons) is wrapped so that a failure there is
 * reported with `console.warn` once and never prevents a screen from showing: a game with a plain title
 * screen beats a game that cannot start.
 *
 * @param {Document} doc
 * @param {HTMLCanvasElement} atlasCanvas  from atlas.createAtlasCanvas()
 * @param {MenusCallbacks} [callbacks]
 * @returns {Menus}
 */
export function createMenus(doc, atlasCanvas, callbacks = {}) {
  const el = bindElements(doc);
  const win = doc.defaultView || globalThis;

  const state = {
    hasSave: false,
    lastSplash: -1,
    backgroundApplied: false,
    pickerOpen: false,
    pickerKeysAttached: false,
    /** @type {number|null} block id of the hovered / focused picker cell */
    hoveredId: null,
    /** @type {HTMLElement|null} */
    hoveredCell: null,
    disposed: false,
  };

  /** @type {{ id: number, cell: HTMLElement }[]} */
  const cells = [];
  /** @type {Array<[EventTarget, string, EventListener]>} static listeners removed by dispose() */
  const listeners = [];
  /** @type {Set<string>} */
  const warned = new Set();

  // ---- small helpers -------------------------------------------------------------------------------

  /** @param {EventTarget} target @param {string} type @param {EventListener} fn */
  function on(target, type, fn) {
    target.addEventListener(type, fn);
    listeners.push([target, type, fn]);
  }

  /** Invoke an optional callback by name. */
  function fire(name, ...args) {
    const fn = callbacks ? callbacks[name] : undefined;
    if (typeof fn === 'function') fn(...args);
  }

  /**
   * Run decorative work; on failure warn once per `what` and return null.
   * @template T @param {() => T} fn @param {string} what @returns {T|null}
   */
  function safe(fn, what) {
    try {
      return fn();
    } catch (err) {
      if (!warned.has(what)) {
        warned.add(what);
        console.warn(`[menus] ${what} unavailable:`, err);
      }
      return null;
    }
  }

  const show = (node) => node.classList.remove('hidden');
  const hide = (node) => node.classList.add('hidden');

  /** Ask the user; when no confirm() exists (non-browser host) there is nobody to ask, so proceed. */
  function confirmDialog(message) {
    return typeof win.confirm === 'function' ? Boolean(win.confirm(message)) : true;
  }

  // ---- shared visuals ------------------------------------------------------------------------------

  /** Random splash, never the same one twice in a row (when there is a choice). */
  function pickSplash() {
    const n = SPLASHES.length;
    if (n === 0) return '';
    let i = Math.floor(Math.random() * n);
    if (i === state.lastSplash && n > 1) i = (i + 1) % n;
    state.lastSplash = i;
    return SPLASHES[i];
  }

  /**
   * Apply the tiled dirt background to the title and loading screens. Encoding the PNG once is enough:
   * the atlas never changes. Also called from showLoading so autoplay/smoke runs that skip the title
   * still get the background.
   */
  function ensureBackground() {
    if (state.backgroundApplied) return;
    state.backgroundApplied = true;
    const url = safe(() => makeTiledBackgroundDataURL(atlasCanvas, TILE.DIRT), 'dirt background');
    if (typeof url === 'string' && url.length > 0) {
      const css = `url("${url}")`;
      el.titleScreen.style.backgroundImage = css;
      el.loadingScreen.style.backgroundImage = css;
    }
  }

  /** Render CONTROLS_SHEET into a `.controls-sheet` grid as alternating <kbd>/<span> children. */
  function renderControlsSheet(container) {
    clearChildren(container);
    for (let i = 0; i < CONTROLS_SHEET.length; i++) {
      const [keys, description] = CONTROLS_SHEET[i];
      const kbd = doc.createElement('kbd');
      kbd.textContent = keys;
      const span = doc.createElement('span');
      span.textContent = description;
      container.appendChild(kbd);
      container.appendChild(span);
    }
  }

  function renderControlsSheets() {
    renderControlsSheet(el.titleControls);
    renderControlsSheet(el.pauseControls);
  }

  // ---- title ---------------------------------------------------------------------------------------

  function showTitle(hasSave) {
    state.hasSave = Boolean(hasSave);
    el.splashText.textContent = pickSplash();
    ensureBackground();
    safe(() => drawTitleLogo(el.titleLogo, atlasCanvas), 'title logo');
    renderControlsSheets();
    /** @type {HTMLButtonElement} */ (el.btnContinue).disabled = !state.hasSave;
    show(el.titleScreen);
  }

  function hideTitle() {
    hide(el.titleScreen);
    // A focused (now invisible) text input would keep swallowing keystrokes in some browsers.
    if (doc.activeElement === el.seedInput && typeof el.seedInput.blur === 'function') el.seedInput.blur();
  }

  function getSeedInput() {
    const v = /** @type {HTMLInputElement} */ (el.seedInput).value;
    return typeof v === 'string' ? v : '';
  }

  function startNewWorld() {
    if (state.hasSave && !confirmDialog(CONFIRM_NEW_WORLD_TEXT)) return;
    fire('onNewWorld', getSeedInput());
  }

  on(el.btnNewWorld, 'click', () => startNewWorld());
  on(el.seedInput, 'keydown', (/** @type {KeyboardEvent} */ e) => {
    if (e.repeat) return;
    if (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      startNewWorld();
    }
  });
  on(el.btnContinue, 'click', () => {
    if (!state.hasSave || /** @type {HTMLButtonElement} */ (el.btnContinue).disabled) return;
    fire('onContinue');
  });

  // ---- loading -------------------------------------------------------------------------------------

  function showLoading(done, total) {
    ensureBackground();
    const t = Number.isFinite(total) && total > 0 ? total : 0;
    const d = Number.isFinite(done) && done > 0 ? Math.min(done, t) : 0;
    const pct = t > 0 ? (d / t) * 100 : 0;
    el.loadingBar.style.width = `${pct}%`;
    el.loadingText.textContent = `${d} / ${t} chunks`;
    show(el.loadingScreen);
  }

  function hideLoading() {
    hide(el.loadingScreen);
  }

  // ---- click to play -------------------------------------------------------------------------------

  function showClickToPlay() {
    show(el.clickToPlay);
  }

  function hideClickToPlay() {
    hide(el.clickToPlay);
  }

  on(el.clickToPlay, 'click', () => fire('onClickToPlay'));

  // ---- pause ---------------------------------------------------------------------------------------

  function showPause(seed) {
    el.pauseSeed.textContent = `Seed: ${seed}`;
    show(el.pauseMenu);
  }

  function hidePause() {
    hide(el.pauseMenu);
  }

  on(el.btnResume, 'click', () => fire('onResume'));
  on(el.btnSave, 'click', () => fire('onSave'));
  on(el.btnStopRunes, 'click', () => fire('onStopRunes'));
  on(el.btnQuit, 'click', () => fire('onQuit'));

  // ---- block picker --------------------------------------------------------------------------------

  /** @param {number} id @param {HTMLElement} cell */
  function setHovered(id, cell) {
    state.hoveredId = id;
    state.hoveredCell = cell;
    el.pickerName.textContent = getBlockDef(id).displayName;
  }

  /** Clear the hover only if `cell` is still the hovered one (focus/blur and mouse events interleave). */
  function clearHovered(cell) {
    if (cell !== undefined && cell !== state.hoveredCell) return;
    state.hoveredId = null;
    state.hoveredCell = null;
    el.pickerName.textContent = PICKER_NAME_IDLE;
  }

  /** Build the PICKER_ORDER picker cells once; they live in #picker-grid for the lifetime of the menus. */
  function buildPickerGrid() {
    clearChildren(el.pickerGrid);
    cells.length = 0;
    for (let i = 0; i < PICKER_ORDER.length; i++) {
      const id = PICKER_ORDER[i];
      const def = getBlockDef(id);
      const cell = /** @type {HTMLButtonElement} */ (doc.createElement('button'));
      cell.type = 'button';
      cell.className = 'picker-cell';
      cell.dataset.blockId = String(id);
      cell.title = def.displayName;
      cell.setAttribute('aria-label', def.displayName);
      const icon = safe(() => makeBlockIconCanvas(atlasCanvas, id, PICKER_ICON_PX), 'block icons');
      if (icon) cell.appendChild(icon);
      on(cell, 'mouseenter', () => setHovered(id, cell));
      on(cell, 'mouseleave', () => clearHovered(cell));
      on(cell, 'focus', () => setHovered(id, cell));
      on(cell, 'blur', () => clearHovered(cell));
      on(cell, 'click', () => fire('onPickBlock', id, null));
      el.pickerGrid.appendChild(cell);
      cells.push({ id, cell });
    }
  }

  /**
   * Mark which blocks are already in the hotbar (data-slot, .in-hotbar, tooltip) and which one is the
   * selected slot (.selected). Purely informational; the CSS may or may not style these hooks.
   * @param {number[]|undefined} hotbar @param {number|undefined} selected
   */
  function markHotbar(hotbar, selected) {
    const bar = Array.isArray(hotbar) ? hotbar : [];
    for (let i = 0; i < cells.length; i++) {
      const { id, cell } = cells[i];
      const slot = bar.indexOf(id);
      const name = getBlockDef(id).displayName;
      if (slot >= 0) {
        cell.dataset.slot = String(slot);
        cell.title = `${name} — slot ${slot + 1}`;
        cell.classList.add('in-hotbar');
      } else {
        delete cell.dataset.slot;
        cell.title = name;
        cell.classList.remove('in-hotbar');
      }
      cell.classList.toggle('selected', slot >= 0 && slot === selected);
    }
  }

  /** Document-level key handling, attached only while the picker is open. @param {KeyboardEvent} e */
  function onPickerKeyDown(e) {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const code = e.code || codeFromKey(e.key);
    if (code === 'Escape' || code === 'KeyE') {
      e.preventDefault();
      fire('onPickerClose');
      return;
    }
    const slot = slotFromDigitCode(code);
    if (slot >= 0 && state.hoveredId !== null) {
      e.preventDefault();
      fire('onPickBlock', state.hoveredId, slot);
    }
  }

  function attachPickerKeys() {
    if (state.pickerKeysAttached) return;
    state.pickerKeysAttached = true;
    doc.addEventListener('keydown', onPickerKeyDown);
  }

  function detachPickerKeys() {
    if (!state.pickerKeysAttached) return;
    state.pickerKeysAttached = false;
    doc.removeEventListener('keydown', onPickerKeyDown);
  }

  function showPicker(hotbar, selected) {
    if (state.disposed) return;
    markHotbar(hotbar, selected);
    clearHovered();
    state.pickerOpen = true;
    attachPickerKeys();
    show(el.blockPicker);
  }

  function hidePicker() {
    detachPickerKeys();
    state.pickerOpen = false;
    clearHovered();
    hide(el.blockPicker);
  }

  function isPickerOpen() {
    return state.pickerOpen;
  }

  // ---- lifecycle -----------------------------------------------------------------------------------

  function dispose() {
    if (state.disposed) return;
    state.disposed = true;
    detachPickerKeys();
    state.pickerOpen = false;
    for (let i = 0; i < listeners.length; i++) {
      const [target, type, fn] = listeners[i];
      target.removeEventListener(type, fn);
    }
    listeners.length = 0;
    clearChildren(el.pickerGrid);
    cells.length = 0;
    state.hoveredId = null;
    state.hoveredCell = null;
  }

  // Static content that does not depend on showTitle: the picker grid, and the pause-menu cheat sheet
  // (autoplay/smoke runs never call showTitle but can still pause).
  buildPickerGrid();
  renderControlsSheets();

  return {
    showTitle,
    hideTitle,
    showLoading,
    hideLoading,
    showClickToPlay,
    hideClickToPlay,
    showPause,
    hidePause,
    showPicker,
    hidePicker,
    isPickerOpen,
    getSeedInput,
    dispose,
  };
}
