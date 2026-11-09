// Caelancraft — title (with the Worlds panel) / loading / click-to-play / pause / block-picker screens.
// See src/CONTRACTS.md §20, §41 and docs/SPEC-gameplay.md §5.1–§5.5.
//
// DOM module. Every DOM access goes through the `doc` handed to createMenus and happens inside a
// function, so this file can be imported in Node. Imports: config, blocks, atlas, storage (world names only; per the
// import graph). The Worlds panel never touches storage itself: main lists the slots and acts on the callbacks.
import { HOTBAR_SIZE, MAX_WORLD_NAME_CHARS } from './config.js';
import { TILE, PICKER_ORDER, getBlockDef } from './blocks.js';
import { makeBlockIconCanvas, makeTiledBackgroundDataURL, drawTitleLogo } from './atlas.js';
import { defaultWorldName } from './storage.js';

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
  Object.freeze(['R', 'Run a Rune Block · light a Blast Barrel']),
  Object.freeze(['Shift R', 'Edit the targeted Rune Block (also opens on placing one)']),
  Object.freeze(['Esc', 'Pause · close menus']),
  Object.freeze(['F3', 'Toggle the debug overlay']),
  Object.freeze(['M', 'Mute / unmute sound']),
]);

// ---- Worlds panel text (pure, §41) ------------------------------------------------------------------

const KB = 1024;
const MB = 1024 * 1024;

/**
 * A stored size for people: "512 B", "37 KB", "1.2 MB", "5 MB" (one decimal from 1 MB on, a trailing ".0" dropped).
 * @param {number} n  characters (≈ bytes: saves are ASCII JSON)
 */
export function formatBytes(n) {
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  if (v < KB) return `${Math.round(v)} B`;
  if (v < MB) return `${Math.min(1023, Math.max(1, Math.round(v / KB)))} KB`;
  return `${(v / MB).toFixed(1).replace(/\.0$/, '')} MB`;
}

function plural(n, unit) {
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

/**
 * When a world was last played, relative to `now`: "just now", "5 minutes ago", "2 hours ago", "yesterday",
 * "3 days ago", "2 months ago", "1 year ago"; '' when unknown (0 or not a number). A time in the future reads "just now".
 * @param {number} ts  ms since the epoch
 * @param {number} now  ms since the epoch
 */
export function formatLastPlayed(ts, now) {
  if (!Number.isFinite(ts) || ts <= 0 || !Number.isFinite(now)) return '';
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return 'just now';
  const min = Math.floor(s / 60);
  if (min < 60) return plural(min, 'minute');
  const h = Math.floor(min / 60);
  if (h < 24) return plural(h, 'hour');
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 30) return plural(d, 'day');
  if (d < 365) return plural(Math.max(1, Math.floor(d / 30)), 'month');
  return plural(Math.floor(d / 365), 'year');
}

/**
 * The second line of a Worlds row: "Seed 1234 · played 2 hours ago · 37 KB" (the played part only when known),
 * "Can't be read · 12 KB" for a damaged slot, "No world yet" for an empty one.
 * @param {import('./storage.js').SlotInfo} info
 * @param {number} now
 */
export function slotDetailText(info, now) {
  if (!info || info.status === 'empty') return 'No world yet';
  if (info.status === 'damaged') return `Can't be read · ${formatBytes(info.bytes)}`;
  const parts = [`Seed ${info.seed}`];
  const played = formatLastPlayed(info.lastPlayed, now);
  if (played) parts.push(`played ${played}`);
  parts.push(formatBytes(info.bytes));
  return parts.join(' · ');
}

/**
 * The usage line under the Worlds list: "1.2 MB of ~5 MB (24%)".
 * @param {{ used: number, quota: number, fraction: number }} usage
 */
export function usageLabel(usage) {
  const u = usage || { used: 0, quota: 0, fraction: 0 };
  const pct = Math.round(Math.min(1, Math.max(0, Number(u.fraction) || 0)) * 100);
  return `${formatBytes(u.used)} of ~${formatBytes(u.quota)} (${pct}%)`;
}

/** Usage bar colour class: '' below 75 %, 'warn' below 90 %, 'full' from 90 %. @param {number} fraction */
export function usageLevel(fraction) {
  return fraction >= 0.9 ? 'full' : fraction >= 0.75 ? 'warn' : '';
}

/**
 * The delete dialog's two lines for a slot, naming the world.
 * @param {import('./storage.js').SlotInfo} info
 * @returns {{ title: string, detail: string }}
 */
export function deleteConfirmText(info) {
  if (info.status === 'damaged') {
    return { title: `Delete the damaged world in slot ${info.slot}?`, detail: 'Its save cannot be read. This cannot be undone.' };
  }
  return { title: `Delete “${info.name}”?`, detail: `Slot ${info.slot} · seed ${info.seed}. This cannot be undone.` };
}

/** The slot of the most recently played world (0 when there is none): its row is marked and its Play button focused. */
export function latestSlot(slots) {
  let best = 0;
  let bestTs = -1;
  for (const s of slots || []) {
    if (s && s.status === 'world' && s.lastPlayed > bestTs) {
      best = s.slot;
      bestTs = s.lastPlayed;
    }
  }
  return best;
}

/** #btn-quit labels (§41): normally, and after a Save & Quit whose save failed. */
export const QUIT_LABEL = 'Save & Quit';
export const QUIT_UNSAVED_LABEL = 'Quit Without Saving';

/** Edge length of the block-picker icon canvases, in CSS pixels (CONTRACTS §20). */
export const PICKER_ICON_PX = 64;

/** `#picker-name` content while nothing is hovered: a non-breaking space keeps the line's height. */
const PICKER_NAME_IDLE = ' ';

/** Element ids in index.html this module binds to (property name → id). */
const IDS = Object.freeze({
  titleScreen: 'title-screen',
  titleLogo: 'title-logo',
  splashText: 'splash-text',
  worldsList: 'worlds-list',
  worldsCount: 'worlds-count',
  usageBar: 'usage-bar',
  usageFill: 'usage-fill',
  usageText: 'usage-text',
  worldsMessage: 'worlds-message',
  confirmDialog: 'confirm-dialog',
  confirmText: 'confirm-text',
  confirmDetail: 'confirm-detail',
  confirmYes: 'confirm-yes',
  confirmNo: 'confirm-no',
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
  pauseWorld: 'pause-world',
  pauseSeed: 'pause-seed',
  btnPhysFalling: 'btn-phys-falling',
  btnPhysWater: 'btn-phys-water',
  btnPhysCollapse: 'btn-phys-collapse',
  btnPhysExplosions: 'btn-phys-explosions',
  btnUndoPhysics: 'btn-undo-physics',
  btnZombies: 'btn-zombies',
  pauseControls: 'pause-controls',
  blockPicker: 'block-picker',
  pickerGrid: 'picker-grid',
  pickerName: 'picker-name',
});

/**
 * @typedef {Object} MenusCallbacks  All optional; missing callbacks are simply not fired.
 * @property {(slot: number) => void} [onPlayWorld]   Worlds panel: Play on a filled slot
 * @property {(slot: number, name: string, seedText: string) => void} [onNewWorld]   the New World form of an empty slot
 *   (name and seed text untrimmed; main normalises both)
 * @property {(slot: number, name: string) => void} [onRenameWorld]
 * @property {(slot: number) => void} [onDuplicateWorld]
 * @property {(slot: number) => void} [onDeleteWorld]   fired only after the delete dialog was confirmed
 * @property {() => void} [onResume]
 * @property {() => void} [onSave]
 * @property {() => void} [onStopRunes]   pause-menu "Stop All Rune Scripts"
 * @property {(name: string) => void} [onPhysicsToggle]  pause-menu Physics row: 'falling' | 'water' | 'collapse' | 'explosions'
 * @property {() => void} [onUndoPhysics]  pause-menu "Undo" (the last explosion / collapse / falling tree)
 * @property {() => void} [onZombiesToggle]  pause-menu Creatures row: the world's Zombies switch (§39)
 * @property {() => void} [onQuit]
 * @property {() => void} [onClickToPlay]
 * @property {(blockId: number, slot: number|null) => void} [onPickBlock]  slot 0..8 for Digit1-9, null for a click
 * @property {() => void} [onPickerClose]
 */

/**
 * What the Worlds panel shows besides the slots.
 * @typedef {Object} WorldsOptions
 * @property {number} [now]            ms since the epoch, for "played 2 hours ago" (default Date.now())
 * @property {{ used: number, quota: number, fraction: number }} [usage]   storage.storageUsage(slots)
 * @property {boolean} [readOnly]      ?nosave: Rename / Duplicate / Delete are disabled (New World and Play still work)
 * @property {string|null} [defaultSeed]  prefills the New World form's seed field (?seed=)
 * @property {string} [message]        status line under the list ('' clears it)
 * @property {boolean} [isError]       … shown in red
 * @property {number} [focusSlot]      focus this row's first button after rendering (default: the last played world's
 *                                     Play, else the first New World)
 */

/**
 * @typedef {Object} Menus
 * @property {(slots: import('./storage.js').SlotInfo[], opts?: WorldsOptions) => void} showTitle
 * @property {(slots: import('./storage.js').SlotInfo[], opts?: WorldsOptions) => void} setWorlds   re-render the panel only
 * @property {(text: string, isError?: boolean) => void} showWorldsMessage
 * @property {() => boolean} isConfirmOpen
 * @property {() => void} hideTitle
 * @property {(done: number, total: number) => void} showLoading
 * @property {() => void} hideLoading
 * @property {() => void} showClickToPlay
 * @property {() => void} hideClickToPlay
 * @property {(seed: number|string, physics?: PhysicsMenuState, worldName?: string) => void} showPause
 * @property {(physics: PhysicsMenuState) => void} setPhysicsState   refresh the Physics row and the Undo button
 * @property {(on: boolean) => void} setZombiesState   refresh the Zombies toggle (§39)
 * @property {() => void} hidePause
 * @property {(on: boolean) => void} setQuitUnsaved   #btn-quit: "Save & Quit" / "Quit Without Saving" (after a failed save)
 * @property {(hotbar: number[], selected: number) => void} showPicker
 * @property {() => void} hidePicker
 * @property {() => boolean} isPickerOpen
 * @property {() => string} getSeedInput   the open New World form's seed text ('' when no form is open)
 * @property {() => void} dispose
 */

/**
 * What the pause menu shows about block physics.
 * @typedef {Object} PhysicsMenuState
 * @property {{ falling: boolean, water: boolean, collapse: boolean, explosions: boolean }} switches
 * @property {boolean} canUndo
 * @property {string} [undoKind]   'explosion' | 'collapse' | 'falling tree' … (button label)
 */

/** Physics row buttons: switch name, label, IDS key. */
export const PHYSICS_TOGGLES = Object.freeze([
  Object.freeze(['falling', 'Falling', 'btnPhysFalling']),
  Object.freeze(['water', 'Water', 'btnPhysWater']),
  Object.freeze(['collapse', 'Collapse', 'btnPhysCollapse']),
  Object.freeze(['explosions', 'Explosions', 'btnPhysExplosions']),
]);

/** Undo button label for an event kind ('' / undefined: nothing to undo). */
export function undoButtonLabel(canUndo, kind) {
  if (!canUndo) return 'Undo (nothing to undo)';
  const what = kind === 'explosion' ? 'Explosion' : kind === 'falling tree' ? 'Falling Tree' : kind === 'collapse' ? 'Collapse' : 'Physics Event';
  return `Undo Last ${what}`;
}

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

  const state = {
    /** @type {import('./storage.js').SlotInfo[]} the slots the Worlds panel shows */
    worlds: [],
    /** @type {WorldsOptions} */
    worldsOpts: {},
    /** @type {{ slot: number, mode: 'new'|'rename' }|null} the one open inline form */
    editing: null,
    worldsRenders: 0,
    /** slot the delete dialog is asking about (0 = closed) */
    confirmSlot: 0,
    /** @type {HTMLElement|null} focused before the dialog opened (gets focus back on Cancel) */
    confirmReturn: null,
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

  /** Focus without scrolling the page (where supported). @param {HTMLElement|null|undefined} node */
  function focusEl(node) {
    if (!node || typeof node.focus !== 'function') return;
    try {
      node.focus({ preventScroll: true });
    } catch {
      node.focus();
    }
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

  /**
   * @param {import('./storage.js').SlotInfo[]} slots
   * @param {WorldsOptions} [opts]
   */
  function showTitle(slots, opts = {}) {
    el.splashText.textContent = pickSplash();
    ensureBackground();
    safe(() => drawTitleLogo(el.titleLogo, atlasCanvas), 'title logo');
    renderControlsSheets();
    state.editing = null;
    closeConfirm(false);
    show(el.titleScreen);
    setWorlds(slots, opts);
  }

  function hideTitle() {
    state.editing = null;
    closeConfirm(false);
    hide(el.titleScreen);
    // A focused (now invisible) text input or button would keep swallowing keystrokes in some browsers.
    const active = /** @type {HTMLElement|null} */ (doc.activeElement);
    if (active && el.titleScreen.contains(active) && typeof active.blur === 'function') active.blur();
  }

  /** The open New World form's seed text ('' when no form is open). */
  function getSeedInput() {
    const input = /** @type {HTMLInputElement|null} */ (el.worldsList.querySelector('.slot-seed-input'));
    return input && typeof input.value === 'string' ? input.value : '';
  }

  // ---- Worlds panel (§41) ------------------------------------------------------------------------------

  /** `<tag class=…>text</tag>` @param {string} tag @param {string} className @param {string} [text] */
  function make(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * A row button; `data-action` / `data-slot` route its click through the list's one delegated listener.
   * @param {string} label @param {string} action @param {number} slot @param {string} [aria] @param {boolean} [disabled]
   */
  function slotButton(label, action, slot, aria, disabled = false) {
    const b = /** @type {HTMLButtonElement} */ (make('button', 'mc-button slot-btn', label));
    b.type = 'button';
    b.dataset.action = action;
    b.dataset.slot = String(slot);
    if (aria) b.setAttribute('aria-label', aria);
    if (action === 'delete') b.classList.add('danger');
    if (disabled) {
      b.disabled = true;
      b.title = 'Saving is off (?nosave=1)';
    }
    return b;
  }

  /** `<label for=id>text</label><input id=id …>` inside one wrapper label-pair span. */
  function field(labelText, id, className, value, placeholder) {
    const wrap = make('span', 'slot-field');
    const label = /** @type {HTMLLabelElement} */ (make('label', '', labelText));
    label.htmlFor = id;
    const input = /** @type {HTMLInputElement} */ (make('input', className));
    input.id = id;
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = value;
    if (placeholder) input.placeholder = placeholder;
    wrap.appendChild(label);
    wrap.appendChild(input);
    return { wrap, input };
  }

  /** The inline New World / Rename form that replaces a row's text and buttons. */
  function buildForm(info, mode) {
    const form = /** @type {HTMLFormElement} */ (make('form', 'slot-form'));
    form.noValidate = true;
    form.dataset.slot = String(info.slot);
    form.dataset.mode = mode;
    const name = field('Name', 'world-name-input', 'slot-name-input', mode === 'rename' ? info.name : defaultWorldName(info.slot));
    name.input.maxLength = MAX_WORLD_NAME_CHARS;
    form.appendChild(name.wrap);
    if (mode === 'new') {
      const seed = state.worldsOpts.defaultSeed;
      form.appendChild(field('Seed', 'seed-input', 'slot-seed-input', seed == null ? '' : String(seed), 'random').wrap);
    }
    const buttons = make('span', 'slot-form-buttons');
    const submit = /** @type {HTMLButtonElement} */ (make('button', 'mc-button slot-btn', mode === 'new' ? 'Create' : 'Save'));
    submit.type = 'submit';
    buttons.appendChild(submit);
    buttons.appendChild(slotButton('Cancel', 'cancel', info.slot));
    form.appendChild(buttons);
    return form;
  }

  /** One `li.world-slot` of the list. */
  function buildRow(info, latest, canDuplicate, readOnly) {
    const li = make('li', `world-slot ${info.status}${info.slot === latest ? ' latest' : ''}`);
    li.dataset.slot = String(info.slot);
    li.appendChild(make('div', 'slot-num', String(info.slot)));
    const editing = state.editing && state.editing.slot === info.slot ? state.editing.mode : null;
    if (editing) {
      li.classList.add('editing');
      li.appendChild(buildForm(info, editing));
      return li;
    }
    const body = make('div', 'slot-body');
    const title = info.status === 'world' ? info.name : info.status === 'damaged' ? 'Damaged world' : 'Empty';
    const name = make('div', 'slot-name', title);
    if (info.status === 'world') name.title = info.name;
    body.appendChild(name);
    body.appendChild(make('div', 'slot-detail', slotDetailText(info, state.worldsOpts.now ?? Date.now())));
    li.appendChild(body);
    const actions = make('div', 'slot-actions');
    if (info.status === 'world') {
      actions.appendChild(slotButton('Play', 'play', info.slot, `Play ${info.name}`));
      actions.appendChild(slotButton('Rename', 'rename', info.slot, `Rename ${info.name}`, readOnly));
      if (canDuplicate) actions.appendChild(slotButton('Duplicate', 'duplicate', info.slot, `Duplicate ${info.name}`, readOnly));
      actions.appendChild(slotButton('Delete', 'delete', info.slot, `Delete ${info.name}`, readOnly));
    } else if (info.status === 'damaged') {
      actions.appendChild(slotButton('Delete', 'delete', info.slot, `Delete the damaged world in slot ${info.slot}`, readOnly));
    } else {
      actions.appendChild(slotButton('New World', 'new', info.slot, `New world in slot ${info.slot}`));
    }
    li.appendChild(actions);
    return li;
  }

  /** The row element of `slot`, or null. */
  function rowOf(slot) {
    return /** @type {HTMLElement|null} */ (el.worldsList.querySelector(`li[data-slot="${slot}"]`));
  }

  /** Focus a row's first enabled control (a form's name field, else its first button). */
  function focusRow(slot) {
    const row = rowOf(slot);
    if (!row) return false;
    const input = /** @type {HTMLInputElement|null} */ (row.querySelector('.slot-name-input'));
    if (input) {
      focusEl(input);
      if (typeof input.select === 'function') input.select();
      return true;
    }
    const btn = /** @type {HTMLElement|null} */ (row.querySelector('button:not([disabled])'));
    focusEl(btn);
    return Boolean(btn);
  }

  /** Re-render the list, the count and the usage bar from state. */
  function renderWorlds() {
    state.worldsRenders++;
    const slots = state.worlds;
    const o = state.worldsOpts;
    const latest = latestSlot(slots);
    const canDuplicate = slots.some((s) => s.status === 'empty');
    clearChildren(el.worldsList);
    for (const info of slots) el.worldsList.appendChild(buildRow(info, latest, canDuplicate, Boolean(o.readOnly)));
    const used = slots.filter((s) => s.status !== 'empty').length;
    el.worldsCount.textContent = `${used} of ${slots.length} slots used${o.readOnly ? ' · saving off' : ''}`;
    const usage = o.usage || { used: 0, quota: 0, fraction: 0 };
    const fraction = Math.min(1, Math.max(0, Number(usage.fraction) || 0));
    el.usageFill.style.width = `${(fraction * 100).toFixed(1)}%`;
    el.usageFill.classList.remove('warn', 'full');
    const level = usageLevel(fraction);
    if (level) el.usageFill.classList.add(level);
    el.usageText.textContent = usageLabel(usage);
    el.usageBar.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    el.usageBar.setAttribute('aria-valuetext', el.usageText.textContent);
  }

  /**
   * Show these slots in the Worlds panel (keeps the title as it is).
   * @param {import('./storage.js').SlotInfo[]} slots
   * @param {WorldsOptions} [opts]
   */
  function setWorlds(slots, opts = {}) {
    state.worlds = Array.isArray(slots) ? slots.slice() : [];
    state.worldsOpts = { ...opts };
    if (state.editing) {
      // a form stays open only while its slot still fits it (another tab may have changed the slot)
      const info = state.worlds.find((s) => s.slot === state.editing.slot);
      const want = state.editing.mode === 'new' ? 'empty' : 'world';
      if (!info || info.status !== want) state.editing = null;
    }
    renderWorlds();
    showWorldsMessage(opts.message || '', Boolean(opts.isError));
    if (el.titleScreen.classList.contains('hidden') || state.confirmSlot) return;
    if (opts.focusSlot && focusRow(opts.focusSlot)) return;
    const latest = latestSlot(state.worlds);
    const empty = state.worlds.find((s) => s.status === 'empty');
    focusRow(latest || (empty ? empty.slot : 1));
  }

  /** The status line under the list ('' clears it). @param {string} text @param {boolean} [isError] */
  function showWorldsMessage(text, isError = false) {
    el.worldsMessage.textContent = text || '';
    el.worldsMessage.classList.toggle('error', Boolean(text) && Boolean(isError));
  }

  /** Open (or switch to) the inline form of `slot`. @param {number} slot @param {'new'|'rename'} mode */
  function openForm(slot, mode) {
    state.editing = { slot, mode };
    renderWorlds();
    focusRow(slot);
  }

  function cancelForm() {
    const slot = state.editing ? state.editing.slot : 0;
    state.editing = null;
    renderWorlds();
    if (slot) focusRow(slot);
  }

  /** @param {HTMLFormElement} form */
  function submitForm(form) {
    const slot = Number(form.dataset.slot);
    const mode = form.dataset.mode;
    const nameInput = /** @type {HTMLInputElement|null} */ (form.querySelector('.slot-name-input'));
    const seedInput = /** @type {HTMLInputElement|null} */ (form.querySelector('.slot-seed-input'));
    const name = nameInput ? nameInput.value : '';
    const seed = seedInput ? seedInput.value : '';
    state.editing = null;
    const renders = state.worldsRenders;
    if (mode === 'new') fire('onNewWorld', slot, name, seed);
    else fire('onRenameWorld', slot, name);
    // Nobody re-rendered (no callback, or the title stays up without a refresh): close the form here.
    if (state.worldsRenders === renders && !el.titleScreen.classList.contains('hidden')) {
      renderWorlds();
      focusRow(slot);
    }
  }

  /** The delete dialog for `slot`, naming its world; Cancel has the focus. */
  function openConfirm(slot) {
    const info = state.worlds.find((s) => s.slot === slot);
    if (!info || info.status === 'empty') return;
    const text = deleteConfirmText(info);
    el.confirmText.textContent = text.title;
    el.confirmDetail.textContent = text.detail;
    state.confirmSlot = slot;
    state.confirmReturn = /** @type {HTMLElement|null} */ (doc.activeElement);
    show(el.confirmDialog);
    focusEl(el.confirmNo);
  }

  /** @param {boolean} restoreFocus  give the focus back to what had it (Cancel / Esc) */
  function closeConfirm(restoreFocus) {
    const back = state.confirmReturn;
    state.confirmSlot = 0;
    state.confirmReturn = null;
    if (el.confirmDialog.classList.contains('hidden')) return;
    hide(el.confirmDialog);
    if (restoreFocus && back && el.titleScreen.contains(back)) focusEl(back);
  }

  function isConfirmOpen() {
    return state.confirmSlot !== 0;
  }

  on(el.worldsList, 'click', (e) => {
    const target = /** @type {HTMLElement|null} */ (e.target);
    const btn = target && typeof target.closest === 'function' ? /** @type {HTMLButtonElement|null} */ (target.closest('button[data-action]')) : null;
    if (!btn || btn.disabled) return;
    const slot = Number(btn.dataset.slot);
    switch (btn.dataset.action) {
      case 'play':
        fire('onPlayWorld', slot);
        break;
      case 'new':
        openForm(slot, 'new');
        break;
      case 'rename':
        openForm(slot, 'rename');
        break;
      case 'duplicate':
        fire('onDuplicateWorld', slot);
        break;
      case 'delete':
        openConfirm(slot);
        break;
      case 'cancel':
        cancelForm();
        break;
      default:
        break;
    }
  });
  on(el.worldsList, 'submit', (e) => {
    e.preventDefault();
    submitForm(/** @type {HTMLFormElement} */ (e.target));
  });
  on(el.worldsList, 'keydown', (/** @type {KeyboardEvent} */ e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const key = e.key;
    if ((key === 'Escape' || key === 'Esc') && state.editing) {
      e.preventDefault();
      e.stopPropagation();
      cancelForm();
      return;
    }
    // Arrow keys walk the rows' buttons: up / down to the same button (or the nearest) of the row above / below,
    // left / right along a row. Text fields keep their arrows.
    if (target.tagName !== 'BUTTON' || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) return;
    const row = /** @type {HTMLElement|null} */ (target.closest('li.world-slot'));
    if (!row) return;
    const buttons = (r) => Array.from(r.querySelectorAll('button:not([disabled])'));
    const own = buttons(row);
    const i = own.indexOf(target);
    let next = null;
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      next = own[i + (key === 'ArrowRight' ? 1 : -1)] || null;
    } else {
      const rows = Array.from(el.worldsList.querySelectorAll('li.world-slot'));
      const j = rows.indexOf(row) + (key === 'ArrowDown' ? 1 : -1);
      if (j >= 0 && j < rows.length) {
        const other = buttons(rows[j]);
        next = other[Math.min(Math.max(0, i), other.length - 1)] || null;
      }
    }
    if (next) {
      e.preventDefault();
      focusEl(/** @type {HTMLElement} */ (next));
    }
  });

  on(el.confirmYes, 'click', () => {
    const slot = state.confirmSlot;
    closeConfirm(false);
    if (slot) fire('onDeleteWorld', slot);
  });
  on(el.confirmNo, 'click', () => closeConfirm(true));
  on(el.confirmDialog, 'click', (e) => {
    if (e.target === el.confirmDialog) closeConfirm(true); // a click on the dimmed backdrop cancels
  });
  on(el.confirmDialog, 'keydown', (/** @type {KeyboardEvent} */ e) => {
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      e.stopPropagation();
      closeConfirm(true);
    } else if (e.key === 'Tab') {
      // keep the focus on the dialog's two buttons
      e.preventDefault();
      focusEl(doc.activeElement === el.confirmNo ? el.confirmYes : el.confirmNo);
    }
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

  /** @param {number|string} seed @param {PhysicsMenuState} [physics] @param {string} [worldName]  shown under the title */
  function showPause(seed, physics, worldName) {
    el.pauseWorld.textContent = typeof worldName === 'string' ? worldName : '';
    el.pauseWorld.classList.toggle('hidden', !worldName);
    setQuitUnsaved(false);
    el.pauseSeed.textContent = `Seed: ${seed}`;
    if (physics) setPhysicsState(physics);
    show(el.pauseMenu);
  }

  /** @param {PhysicsMenuState} physics */
  function setPhysicsState(physics) {
    if (!physics || !physics.switches) return;
    for (const [name, label, key] of PHYSICS_TOGGLES) {
      const btn = el[/** @type {keyof typeof IDS} */ (key)];
      const on = physics.switches[name] !== false;
      btn.textContent = `${label}: ${on ? 'ON' : 'OFF'}`;
      btn.classList.toggle('off', !on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const undo = /** @type {HTMLButtonElement} */ (el.btnUndoPhysics);
    undo.textContent = undoButtonLabel(physics.canUndo, physics.undoKind);
    undo.disabled = !physics.canUndo;
  }

  function hidePause() {
    hide(el.pauseMenu);
  }

  /**
   * §41: #btn-quit reads "Save & Quit", or "Quit Without Saving" (class `danger`) after a Save & Quit whose save failed.
   * @param {boolean} on
   */
  function setQuitUnsaved(on) {
    el.btnQuit.textContent = on ? QUIT_UNSAVED_LABEL : QUIT_LABEL;
    el.btnQuit.classList.toggle('danger', Boolean(on));
  }

  /** The Creatures row's Zombies toggle (§39): "Zombies: ON|OFF", class `off`, aria-pressed. @param {boolean} on */
  function setZombiesState(on) {
    const btn = el.btnZombies;
    btn.textContent = `Zombies: ${on ? 'ON' : 'OFF'}`;
    btn.classList.toggle('off', !on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  on(el.btnZombies, 'click', () => fire('onZombiesToggle'));

  on(el.btnResume, 'click', () => fire('onResume'));
  on(el.btnSave, 'click', () => fire('onSave'));
  on(el.btnStopRunes, 'click', () => fire('onStopRunes'));
  for (const [name, , key] of PHYSICS_TOGGLES) {
    on(el[/** @type {keyof typeof IDS} */ (key)], 'click', () => fire('onPhysicsToggle', name));
  }
  on(el.btnUndoPhysics, 'click', () => {
    if (!/** @type {HTMLButtonElement} */ (el.btnUndoPhysics).disabled) fire('onUndoPhysics');
  });
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
    clearChildren(el.worldsList);
    state.editing = null;
    state.confirmSlot = 0;
    state.confirmReturn = null;
  }

  // Static content that does not depend on showTitle: the picker grid, and the pause-menu cheat sheet
  // (autoplay/smoke runs never call showTitle but can still pause).
  buildPickerGrid();
  renderControlsSheets();

  return {
    showTitle,
    setWorlds,
    showWorldsMessage,
    isConfirmOpen,
    hideTitle,
    showLoading,
    hideLoading,
    showClickToPlay,
    hideClickToPlay,
    showPause,
    hidePause,
    setQuitUnsaved,
    setPhysicsState,
    setZombiesState,
    showPicker,
    hidePicker,
    isPickerOpen,
    getSeedInput,
    dispose,
  };
}
