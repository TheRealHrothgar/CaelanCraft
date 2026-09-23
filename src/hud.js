// Caelancraft — in-game HUD: hotbar icons and selection, block/save toasts, F3 debug overlay,
// underwater tint, error banner and the picker-open state. See src/CONTRACTS.md §19 and
// docs/SPEC-gameplay.md §5.1, §5.2, §5.5.
//
// DOM module. Nothing here touches `document` at module top level: everything is bound inside
// createHUD(doc, atlasCanvas) so the module can be imported (and unit-tested) under Node.
import { HOTBAR_SIZE } from './config.js';
import { BLOCK } from './blocks.js';
import { drawBlockIcon } from './atlas.js';

/** Hotbar slot icons are drawn at this size (matches the 32×32 canvas.slot-icon in index.html). */
export const ICON_SIZE = 32;
/** Block-name toast: fully visible for this long, then fades. */
export const BLOCK_TOAST_MS = 1500;
/** Duration of the `.fade` opacity transition (matches `#block-toast{transition:opacity .3s}`). */
export const TOAST_FADE_MS = 300;
/** Save toast visibility. */
export const SAVE_TOAST_MS = 1500;
/** Oldest error lines are dropped beyond this many, so a per-frame error cannot grow the DOM forever. */
export const MAX_ERROR_LINES = 50;

const HIDDEN = 'hidden';
const SELECTED = 'selected';
const FADE = 'fade';
const ERROR = 'error';
const PICKER_OPEN = 'picker-open';

/**
 * @typedef {Object} HUD
 * @property {(ids: number[], selected?: number) => void} setHotbar   redraw every slot icon (AIR → blank) and, when given, the selection
 * @property {(i: number) => void} setSelected                        highlight slot i (0..8); out-of-range values are ignored
 * @property {() => number} getSelected
 * @property {(text: string) => void} showBlockToast                  visible 1.5 s, then `.fade` 0.3 s, then `.hidden`; restarts on every call
 * @property {(text: string) => void} setDebugText
 * @property {(on: boolean) => void} setDebugVisible
 * @property {() => boolean} toggleDebug                              returns the new visibility
 * @property {() => boolean} isDebugVisible
 * @property {(on: boolean) => void} setUnderwater
 * @property {(text: string, isError?: boolean) => void} showSaveToast  visible 1.5 s; `.error` class while isError
 * @property {(text: string|{message:string}) => void} showError      appends a line to #error-banner and unhides it
 * @property {(on: boolean) => void} setPickerOpen                    toggles #hud.picker-open (CSS lets hotbar clicks through only then)
 * @property {() => boolean} isPickerOpen
 * @property {(on: boolean) => void} setCrosshairVisible
 * @property {(slot: number) => void} onSlotClick                     assignable; fired for hotbar slot clicks while the picker is open
 * @property {() => void} dispose                                     clears timers and removes listeners
 */

/**
 * Bind the HUD to the elements already present in index.html.
 * Throws with a descriptive message when a required element is missing, so a broken page fails at boot
 * rather than silently doing nothing in-game.
 *
 * @param {Document} [doc=globalThis.document]
 * @param {HTMLCanvasElement} atlasCanvas  the 256×256 atlas used by drawBlockIcon
 * @returns {HUD}
 */
export function createHUD(doc = globalThis.document, atlasCanvas) {
  if (!doc || typeof doc.getElementById !== 'function') {
    throw new TypeError('createHUD: a Document is required');
  }
  /** @param {string} id */
  const req = (id) => {
    const el = doc.getElementById(id);
    if (!el) throw new Error(`createHUD: #${id} not found in the document`);
    return el;
  };

  const hudEl = req('hud');
  const crosshairEl = req('crosshair');
  const hotbarEl = req('hotbar');
  const blockToastEl = req('block-toast');
  const saveToastEl = req('save-toast');
  const debugEl = req('debug-overlay');
  const underwaterEl = req('underwater-overlay');
  const errorEl = req('error-banner');

  // ---------------------------------------------------------------- hotbar slots
  /** @typedef {{ el: Element, canvas: HTMLCanvasElement|null, ctx: CanvasRenderingContext2D|null, drawnId: number }} Slot */
  /** @type {Slot[]} */
  const slots = Array.from(hotbarEl.querySelectorAll('.hotbar-slot'))
    .slice(0, HOTBAR_SIZE)
    .map((el) => {
      const canvas = /** @type {HTMLCanvasElement|null} */ (el.querySelector('canvas.slot-icon'));
      const ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
      if (ctx) ctx.imageSmoothingEnabled = false; // crisp pixel art if the icon painter scales
      return { el, canvas, ctx, drawnId: -1 };
    });
  if (slots.length === 0) {
    throw new Error('createHUD: #hotbar contains no .hotbar-slot elements');
  }

  // Normalise the markup to exactly one selected slot (index.html marks slot 0).
  let selectedIndex = Math.max(0, slots.findIndex((s) => s.el.classList.contains(SELECTED)));
  for (let i = 0; i < slots.length; i++) slots[i].el.classList.toggle(SELECTED, i === selectedIndex);

  let iconFailureReported = false;

  /**
   * Draw one slot icon, skipping the work when the slot already shows this id.
   * A failing icon painter (e.g. bad atlas) must never take the game down: it is reported once
   * through the error banner and the slot is left blank.
   * @param {Slot} slot @param {number} id
   */
  function drawSlot(slot, id) {
    if (slot.drawnId === id) return;
    slot.drawnId = id;
    const { ctx, canvas } = slot;
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width || ICON_SIZE, canvas.height || ICON_SIZE);
    if (id === BLOCK.AIR) return;
    try {
      drawBlockIcon(ctx, atlasCanvas, id, ICON_SIZE);
    } catch (err) {
      if (!iconFailureReported) {
        iconFailureReported = true;
        const msg = err && err.message ? err.message : String(err);
        console.warn('hud: drawBlockIcon failed; hotbar icons left blank:', err);
        showError(`HUD: could not draw hotbar icons (${msg})`);
      }
    }
  }

  /** @param {number[]} ids @param {number} [selected] */
  function setHotbar(ids, selected) {
    for (let i = 0; i < slots.length; i++) {
      const raw = ids ? ids[i] : BLOCK.AIR;
      const id = Number.isInteger(raw) && raw > 0 && raw <= 255 ? raw : BLOCK.AIR;
      drawSlot(slots[i], id);
    }
    if (selected !== undefined) setSelected(selected);
  }

  /** @param {number} i */
  function setSelected(i) {
    if (!Number.isInteger(i) || i < 0 || i >= slots.length) return;
    if (i === selectedIndex) {
      slots[i].el.classList.add(SELECTED); // idempotent repair in case markup was touched elsewhere
      return;
    }
    slots[selectedIndex].el.classList.remove(SELECTED);
    selectedIndex = i;
    slots[i].el.classList.add(SELECTED);
  }

  function getSelected() {
    return selectedIndex;
  }

  // ---------------------------------------------------------------- block toast
  let toastTimer = 0;
  let fadeTimer = 0;

  /** @param {string} text */
  function showBlockToast(text) {
    clearTimeout(toastTimer);
    clearTimeout(fadeTimer);
    blockToastEl.textContent = text == null ? '' : String(text);
    // If we are mid-fade, removing `.fade` would animate opacity 0 → 1 over 0.3 s. Suppress the
    // transition for one style flush so the toast snaps back to fully visible instead.
    blockToastEl.style.transition = 'none';
    blockToastEl.classList.remove(FADE);
    blockToastEl.classList.remove(HIDDEN);
    void blockToastEl.offsetWidth; // force style recalculation while transitions are off
    blockToastEl.style.transition = '';
    toastTimer = setTimeout(() => {
      blockToastEl.classList.add(FADE);
      fadeTimer = setTimeout(() => {
        blockToastEl.classList.add(HIDDEN);
        blockToastEl.classList.remove(FADE);
      }, TOAST_FADE_MS);
    }, BLOCK_TOAST_MS);
  }

  // ---------------------------------------------------------------- save toast
  let saveTimer = 0;

  /** @param {string} text @param {boolean} [isError=false] */
  function showSaveToast(text, isError = false) {
    clearTimeout(saveTimer);
    saveToastEl.textContent = text == null ? '' : String(text);
    saveToastEl.classList.toggle(ERROR, !!isError);
    saveToastEl.classList.remove(HIDDEN);
    saveTimer = setTimeout(() => saveToastEl.classList.add(HIDDEN), SAVE_TOAST_MS);
  }

  // ---------------------------------------------------------------- debug overlay
  let debugVisible = !debugEl.classList.contains(HIDDEN);
  /** @type {string|null} */
  let lastDebugText = null;

  /** Called every frame while visible; skips the DOM write when the text is unchanged. @param {string} text */
  function setDebugText(text) {
    const s = text == null ? '' : String(text);
    if (s === lastDebugText) return;
    lastDebugText = s;
    debugEl.textContent = s;
  }

  /** @param {boolean} on */
  function setDebugVisible(on) {
    debugVisible = !!on;
    debugEl.classList.toggle(HIDDEN, !debugVisible);
  }

  function toggleDebug() {
    setDebugVisible(!debugVisible);
    return debugVisible;
  }

  function isDebugVisible() {
    return debugVisible;
  }

  // ---------------------------------------------------------------- underwater tint
  let underwater = !underwaterEl.classList.contains(HIDDEN);

  /** Called every frame; only touches the DOM on change. @param {boolean} on */
  function setUnderwater(on) {
    const next = !!on;
    if (next === underwater) return;
    underwater = next;
    underwaterEl.classList.toggle(HIDDEN, !next);
  }

  // ---------------------------------------------------------------- error banner
  /** @type {string|null} */
  let lastErrorText = null;
  let lastErrorCount = 0;
  /** @type {Element|null} */
  let lastErrorEl = null;

  /**
   * Append a line and unhide the banner. Consecutive identical messages (typical for a per-frame
   * exception) collapse into one line with a repeat counter.
   * @param {string|{message?: string}} text
   */
  function showError(text) {
    let s;
    if (typeof text === 'string') s = text;
    else if (text && typeof text === 'object' && typeof text.message === 'string') s = text.message;
    else s = String(text);

    if (lastErrorEl && s === lastErrorText) {
      lastErrorCount++;
      lastErrorEl.textContent = `${s} (x${lastErrorCount})`;
    } else {
      const line = doc.createElement('div');
      line.textContent = s;
      errorEl.appendChild(line);
      lastErrorEl = line;
      lastErrorText = s;
      lastErrorCount = 1;
      while (errorEl.childNodes.length > MAX_ERROR_LINES && errorEl.firstChild) {
        errorEl.removeChild(errorEl.firstChild);
      }
    }
    errorEl.classList.remove(HIDDEN);
    errorEl.scrollTop = errorEl.scrollHeight; // keep the newest line in view (banner has overflow:auto)
  }

  // ---------------------------------------------------------------- picker state / crosshair
  let pickerOpen = hudEl.classList.contains(PICKER_OPEN);

  /** @param {boolean} on */
  function setPickerOpen(on) {
    pickerOpen = !!on;
    hudEl.classList.toggle(PICKER_OPEN, pickerOpen);
  }

  function isPickerOpen() {
    return pickerOpen;
  }

  /** @param {boolean} on */
  function setCrosshairVisible(on) {
    crosshairEl.classList.toggle(HIDDEN, !on);
  }

  // ---------------------------------------------------------------- slot click hook
  /** @type {HUD} */
  const hud = {
    setHotbar,
    setSelected,
    getSelected,
    showBlockToast,
    setDebugText,
    setDebugVisible,
    toggleDebug,
    isDebugVisible,
    setUnderwater,
    showSaveToast,
    showError,
    setPickerOpen,
    isPickerOpen,
    setCrosshairVisible,
    onSlotClick: () => {},
    dispose,
  };

  // One listener per slot with the index closed over: no dataset/closest lookups on click and
  // nothing to parse. CSS already blocks hotbar pointer events unless #hud.picker-open, but the
  // JS guard keeps the contract ("only while picker open") independent of the stylesheet.
  const clickHandlers = slots.map((slot, i) => {
    /** @param {Event} ev */
    const handler = (ev) => {
      if (!pickerOpen) return;
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      if (typeof hud.onSlotClick === 'function') hud.onSlotClick(i);
    };
    slot.el.addEventListener('click', handler);
    return handler;
  });

  function dispose() {
    clearTimeout(toastTimer);
    clearTimeout(fadeTimer);
    clearTimeout(saveTimer);
    toastTimer = fadeTimer = saveTimer = 0;
    for (let i = 0; i < slots.length; i++) slots[i].el.removeEventListener('click', clickHandlers[i]);
    hud.onSlotClick = () => {};
  }

  return hud;
}
