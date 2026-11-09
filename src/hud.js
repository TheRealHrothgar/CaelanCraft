// Caelancraft — in-game HUD: hotbar icons and selection, block/save toasts, F3 debug overlay,
// underwater tint, error banner and the picker-open state. See src/CONTRACTS.md §19 and
// docs/SPEC-gameplay.md §5.1, §5.2, §5.5.
// v0.9 Survival (docs/DESIGN-survival.md §9.8; CONTRACTS §48 once merged): the vitals bookends either side of the hotbar
// (Health with Breath on its border, Nourishment, Hydration, the body-temperature gauge), the status chips, the job chip,
// the hex action ring round the crosshair, the hex survival hotbar with stack counts and wear outlines, and the pickup
// tokens that fly to their slot. All of it is hidden in Creative, where the HUD is exactly as before.
// Circuits (docs/DESIGN-circuits.md §6.2.16; CONTRACTS §54 once merged): the black hole's screen flash, #flash-overlay (white
// for a charge's FLASH, void for being swallowed), driven by the pure flashStep: at most one start per 0.5 s, never brighter
// than 0.75, fading on a (1 − t/0.6)² curve (WCAG 2.3.1: fewer than three flashes a second).
//
// DOM module. Nothing here touches `document` at module top level: everything is bound inside
// createHUD(doc, atlasCanvas) so the module can be imported (and unit-tested) under Node.
import {
  HOTBAR_SIZE, CHAT_LINES, CHAT_LINE_MS, BREATH_MAX_S, STAT_MAX, BODY_TEMP_NORMAL, BLACK_HOLE_SCREEN_FLASH_S,
  BLACK_HOLE_SCREEN_FLASH_MAX, BLACK_HOLE_SCREEN_FLASH_GAP_S,
} from './config.js';
import { BLOCK } from './blocks.js';
import { drawBlockIcon } from './atlas.js';
import { maxDurability } from './items.js';
import { createItemIcons } from './itemIcons.js';

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

// ---------------------------------------------------------------- survival (pure helpers, tested)

/** Breath is drawn on the Health cell's six border edges, each worth BREATH_MAX_S / 6 seconds (§9.8). */
export const BREATH_EDGES = 6;
// CONTRACT-ISSUE: §9.8 asks for "a honeycomb pair of 44 px hex cells" with the status chips above the left bookend, and
// tests that the bookends and chips avoid #chat-log (bottom 72px). A pointy-top hex 44 px WIDE is 51 px tall, which
// leaves only 13 px under the chat log for a row of chips; so the cells are 44 px TALL (38 wide), the bookends end at
// bottom 52px, and the chips take bottom 54..70px. The integrator may prefer another reading.
/** Size of a vitals cell: a pointy-top hex 38 px wide and 44 px tall (a honeycomb pair per bookend). */
export const VITAL_W = 38;
export const VITAL_H = 44;
/** Body temperatures at the bottom and top of the gauge, and its green (comfortable) band (§2.3). */
export const TEMP_GAUGE_MIN = 31;
export const TEMP_GAUGE_MAX = 43;
export const TEMP_BAND_LOW = 35.5;
export const TEMP_BAND_HIGH = 38.5;
/** A pickup token's flight to its slot. */
export const PICKUP_FLY_MS = 550;
/** Tokens in flight at once; more pickups only pulse their slot. */
export const MAX_PICKUP_TOKENS = 8;
/** A slot (or the pack glyph) pulses this long when a pickup lands. */
export const PULSE_MS = 420;
/** A pickup token: a 16 px pointy-top hex of the item (its 16 px icon on a honey hex). */
export const TOKEN_W = 16;
export const TOKEN_H = 18;

/** @param {unknown} v @returns {number} a finite number (0 for anything else) */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Round to 0.1 without a negative zero. @param {number} v @returns {string} */
function tenth(v) {
  const r = Math.round(num(v) * 10) / 10;
  return (r === 0 ? 0 : r).toFixed(1);
}

/**
 * How many of the Health cell's six border edges are lit: ceil(breath / (BREATH_MAX_S / 6)), 0..6.
 * @param {number} breath  seconds of breath left
 */
export function breathEdges(breath) {
  const b = Math.max(0, Math.min(BREATH_MAX_S, num(breath)));
  return Math.max(0, Math.min(BREATH_EDGES, Math.ceil(b / (BREATH_MAX_S / BREATH_EDGES) - 1e-9)));
}

/**
 * The vitals as the HUD shows them, rounded (§9.8): health, nourishment and hydration to integers, body and felt
 * temperature to 0.1 °C, breath to its edge count, plus the status labels. setVitals redraws only when this key changes,
 * so a change below the rounding never touches the DOM.
 * @param {{ health?: number, satiation?: number, hydration?: number, temp?: number, felt?: number, breath?: number,
 *   target?: number, labels?: string[] }} v
 * @returns {string}
 */
export function vitalsKey(v) {
  const o = v || {};
  const labels = Array.isArray(o.labels) ? o.labels.join(',') : '';
  const target = o.target === undefined || o.target === null ? '' : tenth(o.target);
  return [
    Math.round(num(o.health)), Math.round(num(o.satiation)), Math.round(num(o.hydration)),
    tenth(o.temp), tenth(o.felt), breathEdges(o.breath), target, labels,
  ].join('|');
}

/**
 * The body temperature the felt temperature drives the body toward, in air (§3.3): below 10 °C felt it falls 0.3 °C per
 * degree, above 30 °C it rises 0.2 °C per degree, and in between it is 37. (Main may pass the exact target instead, e.g.
 * in water.)
 * @param {number} felt
 */
export function airBodyTarget(felt) {
  const f = num(felt);
  return f < 10 ? BODY_TEMP_NORMAL - 0.3 * (10 - f) : f > 30 ? BODY_TEMP_NORMAL + 0.2 * (f - 30) : BODY_TEMP_NORMAL;
}

/**
 * The ▲/▼ trend beside the temperature gauge: where the felt temperature is taking the body ('up', 'down' or '' within
 * 0.2 °C).
 * @param {number} temp  body temperature
 * @param {number} felt  felt temperature
 * @param {number} [target]  the body target when main knows it (water changes the formula); else airBodyTarget(felt)
 * @returns {'up'|'down'|''}
 */
export function tempTrend(temp, felt, target) {
  const t = target === undefined || target === null || !Number.isFinite(Number(target)) ? airBodyTarget(felt) : Number(target);
  const d = t - num(temp);
  return d > 0.2 ? 'up' : d < -0.2 ? 'down' : '';
}

/** The gauge needle's height: 0 at TEMP_GAUGE_MIN (bottom) … 1 at TEMP_GAUGE_MAX (top), clamped. @param {number} temp */
export function tempGaugeLevel(temp) {
  return Math.max(0, Math.min(1, (num(temp) - TEMP_GAUGE_MIN) / (TEMP_GAUGE_MAX - TEMP_GAUGE_MIN)));
}

/** Status chip colour family of a §2.3 label. @param {string} label */
export function chipKind(label) {
  switch (label) {
    case 'Hungry': case 'Starving': return 'hunger';
    case 'Thirsty': case 'Parched': return 'thirst';
    case 'Wounded': return 'hurt';
    case 'Hot': case 'Overheating': case 'Heatstroke': return 'heat';
    case 'Chilled': case 'Cold': case 'Freezing': case 'Hypothermic': return 'cold';
    case 'Drowning': case 'Smothering': return 'breath';
    case 'Sick': return 'sick';
    case 'Wet': return 'wet';
    default: return 'other';
  }
}

/**
 * Durability left as a fraction, or null when the stack shows no wear (empty, not a tool, or new: `d` absent).
 * @param {{k: string, n: number, d?: number}|null|undefined} stack
 * @returns {number|null}
 */
export function wearFraction(stack) {
  if (!stack || stack.d === undefined || stack.d === null) return null;
  const max = maxDurability(stack.k);
  if (!(max > 0)) return null;
  return Math.max(0, Math.min(1, num(stack.d) / max));
}

/** Wear outline colour: honey above 50 %, amber down to 25 %, ember below 25 % (§9.8). @param {number} f */
export function wearLevel(f) {
  return f > 0.5 ? 'good' : f >= 0.25 ? 'worn' : 'low';
}

/** The stack count shown in a slot: the number when more than one, else ''. @param {{n: number}|null|undefined} stack */
export function countText(stack) {
  return stack && stack.n > 1 ? String(stack.n) : '';
}

/**
 * The job chip (§7.2): `Kiln · Copper Ingot 12 s`, with ` +2` when two more lanes are busy.
 * @param {string} station  the lane's label ('Hands', 'Kiln', …)
 * @param {string} name     the job's output name
 * @param {number} seconds  seconds left (rounded up)
 * @param {number} [more=0] other busy lanes
 */
export function jobChipText(station, name, seconds, more = 0) {
  const s = Math.max(0, Math.ceil(num(seconds) - 1e-9));
  return `${station} · ${name} ${s} s${more > 0 ? ` +${more}` : ''}`;
}

// ---------------------------------------------------------------- the screen flash (circuits, pure)

/**
 * @typedef {{ level: number, sinceStart: number }} FlashState  the screen flash's level 0..BLACK_HOLE_SCREEN_FLASH_MAX and
 *   the seconds since the last flash started
 */

/** A screen flash at rest: dark, and ready to start at once. @returns {FlashState} */
export function createFlashState() {
  return { level: 0, sinceStart: Infinity };
}

/**
 * One step of the screen flash (DESIGN-circuits §6.2.16). The flash in progress fades on the (1 − t/0.6)² curve, t being the
 * seconds since it started (BLACK_HOLE_SCREEN_FLASH_S). Then a trigger `{ level }` starts a new flash only when at least
 * BLACK_HOLE_SCREEN_FLASH_GAP_S has passed since the last start, at min(level, BLACK_HOLE_SCREEN_FLASH_MAX) (or the current
 * level, if brighter); otherwise it is ignored. So there are never more than two starts in any second, and the first frame
 * of a flash shows it at full strength (§6.2.16 names the trigger before the decay; fading first is what keeps that frame
 * at the trigger's level). Pure: it mutates and returns `state.level`.
 * @param {FlashState} state
 * @param {number} dt  seconds since the last step
 * @param {{ level: number }|null} [trigger]
 * @returns {number} the level to show, 0..BLACK_HOLE_SCREEN_FLASH_MAX
 */
export function flashStep(state, dt, trigger = null) {
  const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const t0 = Number.isFinite(state.sinceStart) ? state.sinceStart : Infinity;
  const t1 = t0 + d;
  state.sinceStart = t1;
  const T = BLACK_HOLE_SCREEN_FLASH_S;
  if (state.level > 0) {
    if (!(t1 < T)) state.level = 0;
    else if (d > 0) {
      const a = 1 - t0 / T;
      const b = 1 - t1 / T;
      state.level = a > 0 ? state.level * (b / a) * (b / a) : 0;
    }
  }
  const want = trigger ? Number(trigger.level) : 0;
  if (want > 0 && Number.isFinite(want) && state.sinceStart >= BLACK_HOLE_SCREEN_FLASH_GAP_S) {
    state.level = Math.max(state.level, Math.min(BLACK_HOLE_SCREEN_FLASH_MAX, want));
    state.sinceStart = 0;
  }
  if (!(state.level > 1e-4)) state.level = 0;
  return state.level;
}

/** Corners of a pointy-top hex in a w×h box, clockwise from the top: [[x, y] × 6]. */
export function hexCorners(w, h, inset = 0) {
  const x0 = inset;
  const x1 = w - inset;
  const y0 = inset;
  const y1 = h - inset;
  const q = (y1 - y0) / 4;
  return [[w / 2, y0], [x1, y0 + q], [x1, y1 - q], [w / 2, y1], [x0, y1 - q], [x0, y0 + q]];
}

/** @param {number[][]} pts */
function pointsAttr(pts) {
  return pts.map(([x, y]) => `${+x.toFixed(2)},${+y.toFixed(2)}`).join(' ');
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Glyphs drawn for this game (§9.8: no hearts, drumsticks or bubbles), in a 38×44 cell: [SVG tag, attributes] per shape.
 * @type {Readonly<Record<string, ReadonlyArray<[string, Record<string, string|number>]>>>}
 */
const GLYPHS = Object.freeze({
  // a pulse line
  health: [['path', { d: 'M5 23H12L15 17L19 30L23 12L26 23H33', fill: 'none' }]],
  // a seed head: a stalk with alternate grains
  satiation: [
    ['path', { d: 'M19 37V13', fill: 'none' }],
    ['ellipse', { cx: 15.6, cy: 17, rx: 2.3, ry: 3.4, transform: 'rotate(-28 15.6 17)' }],
    ['ellipse', { cx: 22.4, cy: 20.5, rx: 2.3, ry: 3.4, transform: 'rotate(28 22.4 20.5)' }],
    ['ellipse', { cx: 15.6, cy: 24, rx: 2.3, ry: 3.4, transform: 'rotate(-28 15.6 24)' }],
    ['ellipse', { cx: 22.4, cy: 27.5, rx: 2.3, ry: 3.4, transform: 'rotate(28 22.4 27.5)' }],
    ['ellipse', { cx: 19, cy: 11, rx: 1.9, ry: 3, transform: '' }],
  ],
  // a drop over a ripple
  hydration: [
    ['path', { d: 'M19 8C19 8 12.5 17 12.5 21.5A6.5 6.5 0 0 0 25.5 21.5C25.5 17 19 8 19 8Z' }],
    ['path', { d: 'M9 32Q19 37 29 32', fill: 'none' }],
    ['path', { d: 'M13 36.5Q19 39.5 25 36.5', fill: 'none' }],
  ],
});

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
 * @property {(text: string|null) => void} setTargetHint              persistent one-line hint under the crosshair (null hides it)
 * @property {(level: number) => void} setHurtFlash                   red screen-edge vignette 0..1 (a zombie's strike, §39)
 * @property {(level: number, kind?: 'white'|'void') => void} setFlashOverlay   the black hole's screen flash (#flash-overlay,
 *   created before the crosshair when index.html has none): opacity = level 0..1 in 1/32 steps, hidden at 0, white or void;
 *   the DOM is touched only when the step or the kind changes
 * @property {(text: string, isError?: boolean) => void} addChatLine  HUD chat log (last CHAT_LINES lines, each fades after CHAT_LINE_MS)
 * @property {(slot: number) => void} onSlotClick                     assignable; fired for hotbar slot clicks while the picker is open
 * @property {() => void} dispose                                     clears timers and removes listeners
 *
 * v0.9 Survival (§9.8). Each touches the DOM only when its rounded value changes:
 * @property {(on: boolean) => void} setSurvivalVisible               show / hide the vitals, chips, job chip and action ring
 * @property {(v: VitalsView) => void} setVitals                      the bookends, Breath on the Health border, the chips
 * @property {(slots: (import('./types.js').ItemStack|null)[]|null, selected?: number, version?: number) => void} setHotbarStacks
 *   the survival hotbar from pack.slots (slots 0–8, redrawn when `version` or `selected` changes); null → back to Creative's
 *   hotbar (the ids last given to setHotbar)
 * @property {(p: number|null) => void} setActionProgress             the hex ring round the crosshair (0..1; null hides it)
 * @property {(text: string|null) => void} setJobChip                 the soonest job (jobChipText), null hides it
 * @property {(key: string, n: number, from: {x: number, y: number}|null) => void} addPickup   a hex token of the item flies
 *   from `from` (screen px; null: the crosshair) to the hotbar slot holding it, else to the pack glyph, which then pulses
 */

/**
 * What setVitals shows. `satiation` is shown as Nourishment. `target` (optional) is the body temperature the body is
 * heading for, for the ▲/▼ trend; without it the trend uses airBodyTarget(felt).
 * @typedef {{ health: number, satiation: number, hydration: number, temp: number, felt: number, breath: number,
 *   labels?: string[], target?: number }} VitalsView
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
  const targetHintEl = req('target-hint');
  const chatLogEl = req('chat-log');

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

  /** @type {number[]} the ids last given to setHotbar (Creative's hotbar comes back from these) */
  let lastIds = [];
  /** true while the survival hotbar (pack stacks) is shown */
  let stacksShown = false;

  /** @param {number[]} ids @param {number} [selected] */
  function setHotbar(ids, selected) {
    lastIds = Array.isArray(ids) ? ids.slice(0, HOTBAR_SIZE) : [];
    if (stacksShown) {
      // Survival owns the slots; Creative's ids are remembered for the switch back.
      if (selected !== undefined) setSelected(selected);
      return;
    }
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

  // ---------------------------------------------------------------- target hint
  /** @type {string|null} */
  let lastHint = null;

  /** Called every frame; only touches the DOM on change. @param {string|null} text */
  function setTargetHint(text) {
    const s = text == null || text === '' ? null : String(text);
    if (s === lastHint) return;
    lastHint = s;
    if (s === null) {
      targetHintEl.classList.add(HIDDEN);
    } else {
      targetHintEl.textContent = s;
      targetHintEl.classList.remove(HIDDEN);
    }
  }

  // ---------------------------------------------------------------- hurt flash (zombies, §39)
  /** #hurt-overlay: a red vignette, created here when index.html has none. */
  let hurtEl = doc.getElementById('hurt-overlay');
  if (!hurtEl && typeof doc.createElement === 'function') {
    hurtEl = doc.createElement('div');
    hurtEl.id = 'hurt-overlay';
    hurtEl.className = HIDDEN;
    hudEl.insertBefore(hurtEl, hudEl.firstChild);
  }
  let hurtLevel = -1;

  /**
   * Red screen-edge flash when a zombie strikes: level 0..1 (main fades it out). Called every frame; touches the DOM
   * only when the level (in 1/32 steps) changes.
   * @param {number} level
   */
  function setHurtFlash(level) {
    if (!hurtEl) return;
    const q = Math.round(Math.max(0, Math.min(1, Number(level) || 0)) * 32) / 32;
    if (q === hurtLevel) return;
    hurtLevel = q;
    hurtEl.classList.toggle(HIDDEN, q === 0);
    hurtEl.style.opacity = String(q);
  }

  // ---------------------------------------------------------------- the screen flash (black holes, DESIGN-circuits §6.2.16)
  /** #flash-overlay: created here, before the crosshair, when index.html has none (as #hurt-overlay is). */
  let flashEl = doc.getElementById('flash-overlay');
  if (!flashEl && typeof doc.createElement === 'function') {
    flashEl = doc.createElement('div');
    flashEl.id = 'flash-overlay';
    flashEl.className = `${HIDDEN} white`;
    flashEl.setAttribute('aria-hidden', 'true');
    hudEl.insertBefore(flashEl, crosshairEl.parentNode === hudEl ? crosshairEl : hudEl.firstChild);
  }
  let flashLevel = -1;
  /** @type {'white'|'void'} */
  let flashKindShown = 'white';

  /**
   * The screen flash: level 0..1 (main feeds it flashStep's level every frame), white (a charge's FLASH) or void (#0b0908,
   * being swallowed). Touches the DOM only when the level's 1/32 step or the kind changes.
   * @param {number} level @param {'white'|'void'} [kind='white']
   */
  function setFlashOverlay(level, kind = 'white') {
    if (!flashEl) return;
    const k = kind === 'void' ? 'void' : 'white';
    const q = Math.round(Math.max(0, Math.min(1, Number(level) || 0)) * 32) / 32;
    if (k !== flashKindShown) {
      flashKindShown = k;
      flashEl.classList.toggle('white', k === 'white');
      flashEl.classList.toggle('void', k === 'void');
    }
    if (q === flashLevel) return;
    flashLevel = q;
    flashEl.classList.toggle(HIDDEN, q === 0);
    flashEl.style.opacity = String(q);
  }

  // ---------------------------------------------------------------- chat log
  /** @type {Set<number>} */
  const chatTimers = new Set();

  /** @param {string} text @param {boolean} [isError=false] */
  function addChatLine(text, isError = false) {
    const lines = String(text ?? '').split('\n');
    for (const line of lines) {
      const div = doc.createElement('div');
      div.textContent = line;
      if (isError) div.classList.add(ERROR);
      chatLogEl.appendChild(div);
      const timer = setTimeout(() => {
        chatTimers.delete(timer);
        div.classList.add(FADE);
        const t2 = setTimeout(() => {
          chatTimers.delete(t2);
          if (div.parentNode === chatLogEl) chatLogEl.removeChild(div);
        }, TOAST_FADE_MS);
        chatTimers.add(t2);
      }, CHAT_LINE_MS);
      chatTimers.add(timer);
    }
    while (chatLogEl.childNodes.length > CHAT_LINES && chatLogEl.firstChild) chatLogEl.removeChild(chatLogEl.firstChild);
  }

  // ---------------------------------------------------------------- survival (§9.8)
  /** @param {string} id @returns {HTMLElement|null} */
  const opt = (id) => doc.getElementById(id);
  /**
   * A survival container: from index.html, else created in #hud (so an older page still works).
   * @param {string} id @param {string} className
   */
  function container(id, className) {
    let node = opt(id);
    if (!node && typeof doc.createElement === 'function') {
      node = doc.createElement('div');
      node.id = id;
      node.className = `${className} ${HIDDEN}`;
      hudEl.appendChild(node);
    }
    return node;
  }
  /** @param {string} tag @param {Record<string, string|number>} [attrs] */
  function svgEl(tag, attrs = {}) {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== '') node.setAttribute(k, String(v));
    return node;
  }

  /** @type {ReturnType<typeof createItemIcons>|null} created on first use, so Creative never pays for it */
  let itemIcons = null;
  function icons() {
    if (!itemIcons) itemIcons = createItemIcons(doc, atlasCanvas);
    return itemIcons;
  }

  let survivalVisible = false;
  let vitalsBuilt = false;
  /** @type {Record<string, {svg: Element, fill?: Element, needle?: Element, trend?: Element, title?: Element}>} */
  const cells = {};
  /** @type {Element[]} the Health cell's six breath edges, clockwise from the top */
  const breathEdgeEls = [];
  /** @type {Element|null} */
  let breathGroup = null;
  const vitalsLeftEl = container('vitals-left', 'vitals');
  const vitalsRightEl = container('vitals-right', 'vitals');
  const chipsEl = container('status-chips', 'status-chips');
  const jobChipEl = container('job-chip', 'job-chip');
  const actionRingEl = container('action-ring', 'action-ring');
  const pickupLayerEl = container('pickup-layer', 'pickup-layer');
  /** The pack glyph at the strip's right end (pickups that land in the rosette fly here). */
  let packGlyphEl = opt('pack-glyph');
  if (!packGlyphEl && typeof doc.createElement === 'function') {
    packGlyphEl = doc.createElement('div');
    packGlyphEl.id = 'pack-glyph';
    packGlyphEl.setAttribute('aria-hidden', 'true');
    hotbarEl.appendChild(packGlyphEl);
  }

  /**
   * One vitals cell: a hex background, a fill rising from the bottom, the glyph and a rim (temperature: the gauge).
   * @param {Element} parent @param {'health'|'satiation'|'hydration'|'temp'} kind @param {string} label
   */
  function buildCell(parent, kind, label) {
    const svg = svgEl('svg', { class: `vital vital-${kind}`, viewBox: `0 0 ${VITAL_W} ${VITAL_H}`, width: VITAL_W, height: VITAL_H,
      role: 'img', 'aria-label': label });
    const pts = pointsAttr(hexCorners(VITAL_W, VITAL_H));
    const clipId = `hud-clip-${kind}`;
    const defs = svgEl('defs');
    const clip = svgEl('clipPath', { id: clipId });
    clip.appendChild(svgEl('polygon', { points: pts }));
    defs.appendChild(clip);
    const title = svgEl('title');
    title.textContent = label;
    svg.appendChild(title);
    svg.appendChild(defs);
    svg.appendChild(svgEl('polygon', { class: 'vital-bg', points: pts }));
    /** @type {{svg: Element, fill?: Element, needle?: Element, trend?: Element, title?: Element}} */
    const cell = { svg, title };
    if (kind === 'temp') {
      const gradId = 'hud-temp-gradient';
      const grad = svgEl('linearGradient', { id: gradId, x1: 0, y1: 1, x2: 0, y2: 0 });
      const at = (t) => tempGaugeLevel(t).toFixed(3);
      for (const [offset, color] of [[0, '#3a7bd5'], [at(TEMP_BAND_LOW - 0.6), '#4aa3c8'], [at(TEMP_BAND_LOW), '#5fbf5a'],
        [at(TEMP_BAND_HIGH), '#5fbf5a'], [at(TEMP_BAND_HIGH + 0.6), '#e0a03a'], [1, '#d0582a']]) {
        grad.appendChild(svgEl('stop', { offset, 'stop-color': color }));
      }
      defs.appendChild(grad);
      svg.appendChild(svgEl('rect', { class: 'vital-gauge', x: 0, y: 0, width: VITAL_W, height: VITAL_H, fill: `url(#${gradId})`,
        'clip-path': `url(#${clipId})` }));
      const needle = svgEl('g', { class: 'temp-needle', transform: `translate(0 ${VITAL_H / 2})` });
      needle.appendChild(svgEl('line', { x1: 4, y1: 0, x2: VITAL_W - 4, y2: 0 }));
      needle.appendChild(svgEl('path', { d: 'M1 -3.5L6 0L1 3.5Z' }));
      needle.appendChild(svgEl('path', { d: `M${VITAL_W - 1} -3.5L${VITAL_W - 6} 0L${VITAL_W - 1} 3.5Z` }));
      svg.appendChild(needle);
      const trend = svgEl('text', { class: 'temp-trend', x: VITAL_W / 2, y: 12, 'text-anchor': 'middle' });
      svg.appendChild(trend);
      cell.needle = needle;
      cell.trend = trend;
    } else {
      cell.fill = svgEl('rect', { class: 'vital-fill', x: 0, y: VITAL_H, width: VITAL_W, height: 0, 'clip-path': `url(#${clipId})` });
      svg.appendChild(cell.fill);
      const glyph = svgEl('g', { class: 'vital-glyph' });
      for (const [tag, attrs] of GLYPHS[kind]) glyph.appendChild(svgEl(tag, attrs));
      svg.appendChild(glyph);
    }
    svg.appendChild(svgEl('polygon', { class: 'vital-rim', points: pts }));
    if (kind === 'health') {
      // Breath: the cell's own border, one line per edge, clockwise from the top (§9.8)
      breathGroup = svgEl('g', { class: 'breath hidden' });
      const c = hexCorners(VITAL_W, VITAL_H, 0.8);
      for (let i = 0; i < BREATH_EDGES; i++) {
        const [x1, y1] = c[i];
        const [x2, y2] = c[(i + 1) % BREATH_EDGES];
        const edge = svgEl('line', { class: 'breath-edge lit', x1: +x1.toFixed(2), y1: +y1.toFixed(2), x2: +x2.toFixed(2), y2: +y2.toFixed(2) });
        breathEdgeEls.push(edge);
        breathGroup.appendChild(edge);
      }
      svg.appendChild(breathGroup);
    }
    parent.appendChild(svg);
    cells[kind] = cell;
  }

  function buildVitals() {
    if (vitalsBuilt || !vitalsLeftEl || !vitalsRightEl || typeof doc.createElementNS !== 'function') return;
    vitalsBuilt = true;
    for (const node of [vitalsLeftEl, vitalsRightEl]) while (node.firstChild) node.removeChild(node.firstChild);
    buildCell(vitalsLeftEl, 'health', 'Health');
    buildCell(vitalsLeftEl, 'satiation', 'Nourishment');
    buildCell(vitalsRightEl, 'hydration', 'Hydration');
    buildCell(vitalsRightEl, 'temp', 'Body temperature');
  }

  /** @type {string|null} the job chip's text */
  let jobText = null;
  /** @type {number|null} the action ring's progress in whole percent */
  let ringPct = null;
  /** @type {Element|null} */
  let ringStroke = null;

  /** @param {boolean} on */
  function setSurvivalVisible(on) {
    const next = Boolean(on);
    if (next) buildVitals();
    if (next === survivalVisible) return;
    survivalVisible = next;
    hudEl.classList.toggle('survival', next);
    for (const node of [vitalsLeftEl, vitalsRightEl, chipsEl]) if (node) node.classList.toggle(HIDDEN, !next);
    if (jobChipEl) jobChipEl.classList.toggle(HIDDEN, !next || jobText === null);
    if (actionRingEl) actionRingEl.classList.toggle(HIDDEN, !next || ringPct === null);
  }

  let lastVitalsKey = '';
  let lastLabels = '';
  let lastEdges = -1;

  /** @param {VitalsView} v */
  function setVitals(v) {
    if (!v) return;
    const key = vitalsKey(v);
    if (key === lastVitalsKey) return;
    lastVitalsKey = key;
    buildVitals();
    const stat = (kind, value, label) => {
      const cell = cells[kind];
      if (!cell || !cell.fill) return;
      const shown = Math.max(0, Math.min(STAT_MAX, Math.round(num(value))));
      const h = +((VITAL_H * shown) / STAT_MAX).toFixed(2);
      cell.fill.setAttribute('y', String(+(VITAL_H - h).toFixed(2)));
      cell.fill.setAttribute('height', String(h));
      const text = `${label} ${shown}`;
      cell.svg.setAttribute('aria-label', text);
      if (cell.title) cell.title.textContent = text;
    };
    stat('health', v.health, 'Health');
    stat('satiation', v.satiation, 'Nourishment');
    stat('hydration', v.hydration, 'Hydration');
    const temp = cells.temp;
    if (temp && temp.needle) {
      const y = +(VITAL_H * (1 - tempGaugeLevel(Number(tenth(v.temp))))).toFixed(2);
      temp.needle.setAttribute('transform', `translate(0 ${y})`);
      const trend = tempTrend(Number(tenth(v.temp)), Number(tenth(v.felt)), v.target);
      if (temp.trend) {
        temp.trend.textContent = trend === 'up' ? '▲' : trend === 'down' ? '▼' : '';
        temp.trend.setAttribute('class', `temp-trend ${trend}`.trim());
      }
      const text = `Body temperature ${tenth(v.temp)} °C · felt ${tenth(v.felt)} °C`;
      temp.svg.setAttribute('aria-label', text);
      if (temp.title) temp.title.textContent = text;
    }
    const edges = breathEdges(v.breath);
    if (edges !== lastEdges && breathGroup) {
      lastEdges = edges;
      breathGroup.setAttribute('class', `breath${edges === BREATH_EDGES ? ' hidden' : ''}${edges === 0 ? ' out' : ''}`);
      // the edges go dark clockwise from the top as breath drains: the first (6 − lit) edges are dark
      for (let i = 0; i < BREATH_EDGES; i++) {
        breathEdgeEls[i].setAttribute('class', `breath-edge ${i < BREATH_EDGES - edges ? 'dark' : 'lit'}`);
      }
    }
    const labels = Array.isArray(v.labels) ? v.labels : [];
    const labelKey = labels.join(',');
    if (labelKey !== lastLabels && chipsEl) {
      lastLabels = labelKey;
      while (chipsEl.firstChild) chipsEl.removeChild(chipsEl.firstChild);
      for (const label of labels) {
        const chip = doc.createElement('span');
        chip.className = `chip chip-${chipKind(label)}`;
        chip.textContent = label;
        chipsEl.appendChild(chip);
      }
    }
  }

  /** @param {number|null} p */
  function setActionProgress(p) {
    const next = p === null || p === undefined || !Number.isFinite(Number(p)) ? null : Math.round(Math.max(0, Math.min(1, Number(p))) * 100);
    if (next === ringPct) return;
    ringPct = next;
    if (!actionRingEl) return;
    if (!ringStroke && typeof doc.createElementNS === 'function') {
      const svg = svgEl('svg', { viewBox: '0 0 40 46', width: 40, height: 46 });
      const pts = pointsAttr(hexCorners(40, 46, 2));
      svg.appendChild(svgEl('polygon', { class: 'ring-track', points: pts }));
      ringStroke = svgEl('polygon', { class: 'ring-fill', points: pts, pathLength: 100, 'stroke-dasharray': '0 100' });
      svg.appendChild(ringStroke);
      actionRingEl.appendChild(svg);
    }
    if (next !== null && ringStroke) ringStroke.setAttribute('stroke-dasharray', `${next} 100`);
    actionRingEl.classList.toggle(HIDDEN, next === null || !survivalVisible);
  }

  /** @param {string|null} text */
  function setJobChip(text) {
    const next = text === null || text === undefined || text === '' ? null : String(text);
    if (next === jobText) return;
    jobText = next;
    if (!jobChipEl) return;
    if (next !== null) jobChipEl.textContent = next;
    jobChipEl.classList.toggle(HIDDEN, next === null || !survivalVisible);
  }

  // ---- the survival hotbar (§9.8): hex slots with a count and a wear outline
  /** @type {(import('./types.js').ItemStack|null)[]|null} the live pack slots (pack.slots, never copied) */
  let liveSlots = null;
  let lastStackVersion = NaN;
  /** @type {Array<{count: Element|null, wear: Element|null, wearLine: Element|null, sig: string}>} */
  const extras = slots.map(() => ({ count: null, wear: null, wearLine: null, sig: '\u0000' }));

  /** The count and wear outline inside slot i (from index.html, else created). @param {number} i */
  function slotExtras(i) {
    const x = extras[i];
    if (x.count) return x;
    const el = slots[i].el;
    x.count = el.querySelector('.slot-count');
    if (!x.count) {
      x.count = doc.createElement('span');
      x.count.className = 'slot-count';
      el.appendChild(x.count);
    }
    x.wear = el.querySelector('.slot-wear');
    if (!x.wear && typeof doc.createElementNS === 'function') {
      x.wear = svgEl('svg', { class: 'slot-wear hidden', viewBox: '0 0 40 46', width: 40, height: 46 });
      el.appendChild(x.wear);
    }
    if (x.wear) {
      x.wearLine = x.wear.querySelector('polygon');
      if (!x.wearLine) {
        x.wearLine = svgEl('polygon', { points: pointsAttr(hexCorners(40, 46, 3.5)), pathLength: 100, 'stroke-dasharray': '100 100' });
        x.wear.appendChild(x.wearLine);
      }
    }
    return x;
  }

  /** @param {number} i @param {import('./types.js').ItemStack|null} stack */
  function drawStack(i, stack) {
    const x = slotExtras(i);
    const sig = stack ? `${stack.k}|${stack.n}|${stack.d ?? ''}` : '';
    if (sig === x.sig) return;
    const prevKey = x.sig.split('|')[0];
    x.sig = sig;
    const slot = slots[i];
    if (slot.ctx && slot.canvas && (!stack || stack.k !== prevKey)) {
      try {
        icons().draw(slot.ctx, stack ? stack.k : null, ICON_SIZE);
      } catch (err) {
        if (!iconFailureReported) {
          iconFailureReported = true;
          showError(`HUD: could not draw item icons (${err && err.message ? err.message : err})`);
        }
      }
    }
    if (x.count) x.count.textContent = countText(stack);
    const f = wearFraction(stack);
    if (x.wear) {
      x.wear.setAttribute('class', f === null ? 'slot-wear hidden' : `slot-wear ${wearLevel(f)}`);
      if (f !== null && x.wearLine) x.wearLine.setAttribute('stroke-dasharray', `${Math.max(1, Math.round(f * 100))} 100`);
    }
  }

  /**
   * @param {(import('./types.js').ItemStack|null)[]|null} stacks
   * @param {number} [selected]
   * @param {number} [version]
   */
  function setHotbarStacks(stacks, selected, version) {
    if (!Array.isArray(stacks)) {
      liveSlots = null;
      if (stacksShown) {
        stacksShown = false;
        hotbarEl.classList.remove('survival');
        for (let i = 0; i < slots.length; i++) {
          slots[i].drawnId = -1; // the canvas shows an item: force Creative's redraw
          extras[i].sig = '\u0000';
          if (extras[i].count) extras[i].count.textContent = '';
          if (extras[i].wear) extras[i].wear.setAttribute('class', 'slot-wear hidden');
        }
        setHotbar(lastIds);
      }
      if (selected !== undefined) setSelected(selected);
      return;
    }
    liveSlots = stacks;
    if (!stacksShown) {
      stacksShown = true;
      hotbarEl.classList.add('survival');
      lastStackVersion = NaN;
      for (const x of extras) x.sig = '\u0000';
    }
    const sel = selected === undefined ? selectedIndex : selected;
    if (version !== undefined && version === lastStackVersion && sel === selectedIndex) return;
    lastStackVersion = version === undefined ? NaN : version;
    for (let i = 0; i < slots.length; i++) drawStack(i, stacks[i] || null);
    setSelected(sel);
  }

  // ---- pickups: a hex token flies to its slot (or the pack glyph), which then pulses
  /** @type {Set<number>} */
  const pickupTimers = new Set();
  let tokensInFlight = 0;

  /** @param {Element|null} node */
  function pulse(node) {
    if (!node) return;
    node.classList.remove('pulse');
    void (/** @type {HTMLElement} */ (node)).offsetWidth; // restart the animation
    node.classList.add('pulse');
    const t = setTimeout(() => {
      pickupTimers.delete(t);
      node.classList.remove('pulse');
    }, PULSE_MS);
    pickupTimers.add(t);
  }

  /** @param {Element} node @returns {{x: number, y: number}} */
  function centreOf(node) {
    const r = node.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  /** @param {string} key @param {number} _n @param {{x: number, y: number}|null} from */
  function addPickup(key, _n, from) {
    if (!stacksShown || typeof key !== 'string' || key === '') return;
    /** @type {Element|null} */
    let target = packGlyphEl;
    if (liveSlots) {
      for (let i = 0; i < slots.length; i++) {
        if (liveSlots[i] && liveSlots[i].k === key) {
          target = slots[i].el;
          break;
        }
      }
    }
    if (!target) return;
    if (!pickupLayerEl || tokensInFlight >= MAX_PICKUP_TOKENS) {
      pulse(target);
      return;
    }
    const view = doc.defaultView || globalThis;
    const start = from && Number.isFinite(from.x) && Number.isFinite(from.y)
      ? from : { x: num(view.innerWidth) / 2, y: num(view.innerHeight) / 2 };
    const end = centreOf(target);
    const token = doc.createElement('div');
    token.className = 'pickup-token';
    try {
      token.appendChild(icons().canvas(key, 16));
    } catch {
      // an icon failure only loses the picture; the token still flies
    }
    token.style.transform = `translate(${Math.round(start.x - TOKEN_W / 2)}px, ${Math.round(start.y - TOKEN_H / 2)}px)`;
    pickupLayerEl.appendChild(token);
    tokensInFlight++;
    void token.offsetWidth; // commit the start position so the move below transitions
    token.style.transform = `translate(${Math.round(end.x - TOKEN_W / 2)}px, ${Math.round(end.y - TOKEN_H / 2)}px) scale(0.85)`;
    const landOn = target;
    const t = setTimeout(() => {
      pickupTimers.delete(t);
      tokensInFlight--;
      if (token.parentNode) token.parentNode.removeChild(token);
      pulse(landOn);
    }, PICKUP_FLY_MS);
    pickupTimers.add(t);
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
    setTargetHint,
    setHurtFlash,
    setFlashOverlay,
    addChatLine,
    setSurvivalVisible,
    setVitals,
    setHotbarStacks,
    setActionProgress,
    setJobChip,
    addPickup,
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
    for (const t of chatTimers) clearTimeout(t);
    chatTimers.clear();
    for (const t of pickupTimers) clearTimeout(t);
    pickupTimers.clear();
    tokensInFlight = 0;
    if (pickupLayerEl) while (pickupLayerEl.firstChild) pickupLayerEl.removeChild(pickupLayerEl.firstChild);
    for (let i = 0; i < slots.length; i++) slots[i].el.removeEventListener('click', clickHandlers[i]);
    hud.onSlotClick = () => {};
  }

  return hud;
}
