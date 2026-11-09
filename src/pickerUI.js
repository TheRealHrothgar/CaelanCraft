// Caelancraft — the creative inventory's DOM: a honeycomb of hex cells in sections with a section rail, families that open in
// a drawer band below their row, smooth scrolling (wheel, scrollbar, drag on empty space, keyboard), a search box with
// aliases, drag-to-hotbar and slot badges, in the survival honey palette. docs/DESIGN-circuits.md §5 (CONTRACTS §56 once
// merged). The model (sections, families, search, layout, navigation) is pickerModel.js; menus.js builds one of these and
// maps showPicker / hidePicker / isPickerOpen onto it, so main's picker API is unchanged.
//
// DOM module. Every DOM access goes through the `doc` and elements handed to createPickerUI and happens inside a function,
// so the module can be imported (and unit-tested on a fake DOM) under Node. Imports: config, blocks, atlas, pickerModel.
import { HOTBAR_SIZE } from './config.js';
import { getBlockDef } from './blocks.js';
import { drawBlockIcon } from './atlas.js';
import {
  buildPickerModel, layoutPicker, navigate, pushRecent, blurbFor, familyLine, searchBlocks, pickerCols, normalizeQuery,
  PICKER_ROW_H, RECENT_SECTION_ID,
} from './pickerModel.js';

/** Icon canvases are drawn at 64 px and shown at 48 px. */
export const PICKER_ICON_PX = 64;
/** The drag ghost and the rail icons. */
export const PICKER_GHOST_PX = 40;
export const PICKER_RAIL_ICON_PX = 32;
/** A pointer that moves more than this many px after pointerdown drags (and the click is suppressed). */
export const DRAG_START_PX = 6;
/** `#picker-name` while nothing is hovered: a non-breaking space keeps the line's height. */
const NAME_IDLE = ' ';
/** The search's "nothing found" line. @param {string} q */
export const noMatchText = (q) => `No blocks match "${q}"`;

/**
 * @typedef {Object} PickerElements  the picker's static elements in index.html (menus.js binds and checks them)
 * @property {HTMLElement} blockPicker   #block-picker, the layer
 * @property {HTMLElement} pickerGrid    #picker-grid, the honeycomb (inside #picker-scroll)
 * @property {HTMLElement} pickerName    #picker-name
 * @property {HTMLElement} pickerBlurb   #picker-blurb, the tip or the family line
 * @property {HTMLElement} pickerSearch  #picker-search
 * @property {HTMLElement} pickerShowAll #picker-showall (a checkbox)
 * @property {HTMLElement} pickerRail    #picker-rail, the section buttons
 * @property {HTMLElement} pickerScroll  #picker-scroll, the scroll region
 */

/**
 * @typedef {Object} PickerCallbacks
 * @property {(id: number, slot: number|null) => void} [onPick]   a block for the selected slot (null: main closes the picker)
 *   or for slot 0..8 (the picker stays open)
 * @property {() => void} [onClose]                               E / Esc: main closes the picker
 */

/**
 * @typedef {Object} PickerUI
 * @property {(hotbar: number[], selected: number) => void} show   open (or, when open, refresh the slot badges only)
 * @property {() => void} hide
 * @property {() => boolean} isOpen
 * @property {() => void} dispose
 */

/** @param {string|undefined} key @returns {string} a KeyboardEvent.code for events that carry none */
function codeFromKey(key) {
  if (key === 'Escape' || key === 'Esc') return 'Escape';
  if (key === 'e' || key === 'E') return 'KeyE';
  if (typeof key === 'string' && key.length === 1 && key >= '1' && key <= '9') return 'Digit' + key;
  return '';
}

/** @param {string} code @returns {number} hotbar slot 0..8 of Digit1..Digit9, else −1 */
function slotFromDigitCode(code) {
  if (!code.startsWith('Digit')) return -1;
  const n = Number(code.slice(5));
  return Number.isInteger(n) && n >= 1 && n <= HOTBAR_SIZE ? n - 1 : -1;
}

const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);

/**
 * Build the picker on its static elements (§5.9).
 * @param {Document} doc
 * @param {PickerElements} els
 * @param {HTMLCanvasElement} atlasCanvas
 * @param {PickerCallbacks} [callbacks]
 * @returns {PickerUI}
 */
export function createPickerUI(doc, els, atlasCanvas, callbacks = {}) {
  const model = buildPickerModel();
  const win = doc.defaultView || globalThis;
  /** Timers through the document's window (a test's window stand-in may have none: then the global ones). */
  const timers = typeof win.setTimeout === 'function' ? win : globalThis;
  const search = /** @type {HTMLInputElement} */ (els.pickerSearch);
  const showAllBox = /** @type {HTMLInputElement} */ (els.pickerShowAll);
  const scroll = els.pickerScroll;
  const grid = els.pickerGrid;

  const state = {
    open: false,
    disposed: false,
    /** @type {number[]} */
    hotbar: [],
    selected: 0,
    query: '',
    /** @type {string|null} the open family (remembered for the session) */
    openFamily: null,
    showAll: false,
    /** @type {number[]} newest first, applied on the next show() so the grid never jumps under the pointer */
    recent: [],
    /** @type {number[]} the Recent row as laid out */
    recentShown: [],
    cols: 0,
    /** the roving cell (one cell is tabbable) */
    focusIndex: 0,
    /** @type {number|null} block id under the pointer or focus (1–9 put it in that slot) */
    hoverId: null,
    /** @type {HTMLElement|null} */
    hoverCell: null,
    scrollTop: 0,
    suppressClick: false,
    keysAttached: false,
  };
  /** @type {import('./pickerModel.js').Row[]} */
  let rows = [];
  /** @type {HTMLElement[]} the cells of the current layout in reading order (navigate's indices) */
  let flat = [];
  /** @type {Map<string, HTMLElement>} cell elements by `<ctx>:<id>` / `fam:<key>`, built once and re-used */
  const cellCache = new Map();
  /** @type {Map<string, HTMLElement>} rail buttons by section id */
  const railButtons = new Map();
  /** @type {Array<[EventTarget, string, EventListener, boolean]>} */
  const listeners = [];
  /** @type {Set<string>} */
  const warned = new Set();
  /** @type {null|{ id: number, cell: HTMLElement, x0: number, y0: number, started: boolean, ghost: HTMLElement|null, slot: HTMLElement|null, pointerId: number }} */
  let drag = null;
  /** @type {null|{ y0: number, top0: number, moved: boolean, pointerId: number }} */
  let scrollDrag = null;

  // ---- helpers ----------------------------------------------------------------------------------------------------------

  /** @param {EventTarget} target @param {string} type @param {EventListener} fn @param {boolean} [capture] */
  function on(target, type, fn, capture = false) {
    if (!target || typeof target.addEventListener !== 'function') return; // e.g. a window stand-in without events
    target.addEventListener(type, fn, capture);
    listeners.push([target, type, fn, capture]);
  }
  /** @param {EventTarget} target @param {string} type @param {EventListener} fn @param {boolean} [capture] */
  function off(target, type, fn, capture = false) {
    if (!target || typeof target.removeEventListener !== 'function') return;
    target.removeEventListener(type, fn, capture);
    const i = listeners.findIndex((l) => l[0] === target && l[1] === type && l[2] === fn);
    if (i >= 0) listeners.splice(i, 1);
  }
  function fire(name, ...args) {
    const fn = callbacks ? callbacks[name] : undefined;
    if (typeof fn === 'function') fn(...args);
  }
  /** @template T @param {() => T} fn @param {string} what @returns {T|null} */
  function safe(fn, what) {
    try {
      return fn();
    } catch (err) {
      if (!warned.has(what)) {
        warned.add(what);
        console.warn(`[picker] ${what} unavailable:`, err);
      }
      return null;
    }
  }
  /** @param {string} tag @param {string} [className] @param {string} [text] */
  function make(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  /** @param {HTMLElement} el */
  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }
  /** @param {HTMLElement|null|undefined} node */
  function focusEl(node) {
    if (!node || typeof node.focus !== 'function') return;
    try {
      node.focus({ preventScroll: true });
    } catch {
      node.focus();
    }
  }
  /** @param {HTMLElement|null} node @param {'smooth'|'auto'} [behavior] */
  function reveal(node, behavior = 'smooth') {
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest', behavior });
  }
  /** @param {number} id @param {number} px @returns {HTMLCanvasElement} */
  function iconCanvas(id, px) {
    const c = /** @type {HTMLCanvasElement} */ (make('canvas'));
    c.width = px;
    c.height = px;
    safe(() => {
      const ctx = c.getContext('2d');
      if (ctx) drawBlockIcon(ctx, atlasCanvas, id, px);
    }, 'block icons');
    return c;
  }
  const nameOf = (id) => getBlockDef(id).displayName;

  // ---- cells ------------------------------------------------------------------------------------------------------------

  /** A block cell (cached per context: the Recent row and the main grid each have their own). @param {number} id @param {string} ctx */
  function blockCell(id, ctx) {
    const cacheKey = `${ctx}:${id}`;
    let cell = cellCache.get(cacheKey);
    if (cell) return cell;
    cell = make('button', 'picker-cell');
    cell.setAttribute('type', 'button');
    cell.setAttribute('role', 'gridcell');
    cell.setAttribute('tabindex', '-1');
    cell.dataset.blockId = String(id);
    cell.title = nameOf(id);
    cell.setAttribute('aria-label', nameOf(id));
    const icon = iconCanvas(id, PICKER_ICON_PX);
    icon.className = 'picker-icon';
    cell.appendChild(icon);
    const badge = make('span', 'picker-badge');
    badge.setAttribute('aria-hidden', 'true');
    cell.appendChild(badge);
    cellCache.set(cacheKey, cell);
    return cell;
  }

  /** A family tile: three member icons fanned in a stack (composited once), the count badge and the ▸ chevron (§5.2). */
  function familyCell(family) {
    const cacheKey = `fam:${family.key}`;
    let cell = cellCache.get(cacheKey);
    if (cell) return cell;
    cell = make('button', 'picker-cell picker-family');
    cell.setAttribute('type', 'button');
    cell.setAttribute('role', 'gridcell');
    cell.setAttribute('tabindex', '-1');
    cell.setAttribute('aria-expanded', 'false');
    cell.dataset.family = family.key;
    cell.title = familyLine(family);
    cell.setAttribute('aria-label', `${family.name}: ${family.ids.length} ${family.unit}`);
    const fan = /** @type {HTMLCanvasElement} */ (make('canvas', 'picker-icon'));
    fan.width = PICKER_ICON_PX;
    fan.height = PICKER_ICON_PX;
    safe(() => drawFan(fan, family.ids), 'block icons');
    cell.appendChild(fan);
    cell.appendChild(make('span', 'picker-count', String(family.ids.length)));
    cell.appendChild(make('span', 'picker-chevron', '▸'));
    cellCache.set(cacheKey, cell);
    return cell;
  }

  /**
   * Three member icons fanned like a hand of cards: the third and second tilted behind, the first in front.
   * @param {HTMLCanvasElement} canvas @param {number[]} ids
   */
  function drawFan(canvas, ids) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const S = PICKER_ICON_PX;
    const s = 42;
    const picks = [
      [ids[2] ?? ids[1] ?? ids[0], 0.26, S - s / 2 - 1, s / 2 + 3],
      [ids[1] ?? ids[0], -0.26, s / 2 + 1, s / 2 + 3],
      [ids[0], 0, S / 2, S - s / 2 - 1],
    ];
    ctx.clearRect(0, 0, S, S);
    for (const [id, a, cx, cy] of picks) {
      const icon = iconCanvas(id, s);
      ctx.save();
      ctx.imageSmoothingEnabled = a !== 0;
      ctx.setTransform(Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), cx, cy);
      ctx.drawImage(icon, -s / 2, -s / 2, s, s);
      ctx.restore();
    }
  }

  /** @param {import('./pickerModel.js').Entry} entry @param {string} ctx */
  function cellFor(entry, ctx) {
    return entry.type === 'family' ? familyCell(entry) : blockCell(entry.id, ctx);
  }

  // ---- slot badges --------------------------------------------------------------------------------------------------------

  /** Badges on the blocks already in the hotbar (their slot number) and a honey ring on the block in the selected slot. */
  function markHotbar() {
    const bar = state.hotbar;
    for (const [cacheKey, cell] of cellCache) {
      if (cacheKey.startsWith('fam:')) continue;
      const id = Number(cell.dataset.blockId);
      const slot = bar.indexOf(id);
      const badge = /** @type {HTMLElement|null} */ (cell.querySelector('.picker-badge'));
      if (slot >= 0) {
        cell.dataset.slot = String(slot);
        cell.title = `${nameOf(id)} — slot ${slot + 1}`;
        cell.classList.add('in-hotbar');
        if (badge) badge.textContent = String(slot + 1);
      } else {
        delete cell.dataset.slot;
        cell.title = nameOf(id);
        cell.classList.remove('in-hotbar');
        if (badge) badge.textContent = '';
      }
      cell.classList.toggle('selected', slot >= 0 && bar[state.selected] === id);
    }
  }

  // ---- the name line ------------------------------------------------------------------------------------------------------

  /** @param {HTMLElement} cell */
  function setHover(cell) {
    state.hoverCell = cell;
    const fam = cell.dataset.family;
    if (fam !== undefined) {
      const family = model.families.get(fam);
      state.hoverId = null;
      els.pickerName.textContent = family ? familyLine(family, state.openFamily === fam) : NAME_IDLE;
      els.pickerBlurb.textContent = '';
      return;
    }
    const id = Number(cell.dataset.blockId);
    state.hoverId = id;
    els.pickerName.textContent = nameOf(id);
    els.pickerBlurb.textContent = blurbFor(id);
  }

  /** Clear the line, but only if `cell` is still the hovered one (pointer and focus events interleave). @param {HTMLElement} [cell] */
  function clearHover(cell) {
    if (cell !== undefined && cell !== state.hoverCell) return;
    state.hoverId = null;
    state.hoverCell = null;
    els.pickerName.textContent = NAME_IDLE;
    els.pickerBlurb.textContent = '';
  }

  // ---- layout -------------------------------------------------------------------------------------------------------------

  function measureCols() {
    const w = Number(scroll.clientWidth) || 0;
    return pickerCols(w > 0 ? w - 16 : 0); // the grid's 8 px side padding
  }

  /** Re-lay the grid from the state (cells are re-used, only the row containers are new). */
  function render() {
    const focusedEl = flat[state.focusIndex] || null;
    const hadFocus = focusedEl !== null && doc.activeElement === focusedEl;
    state.recentShown = state.recent.slice();
    rows = layoutPicker(model, { cols: state.cols, openFamily: state.openFamily, showAll: state.showAll, query: state.query,
      recent: state.recentShown });
    clear(grid);
    flat = [];
    grid.style.setProperty('--cols', String(state.cols));
    grid.classList.toggle('searching', Boolean(normalizeQuery(state.query)));
    if (normalizeQuery(state.query)) {
      const n = searchBlocks(model, state.query).length;
      grid.appendChild(make('div', 'picker-results', n === 0 ? noMatchText(String(search.value ?? state.query).trim())
        : `${n} block${n === 1 ? '' : 's'}`));
    }
    /** @type {HTMLElement} */
    let container = grid;
    /** @type {HTMLElement|null} */
    let combEl = null;
    /** @type {HTMLElement|null} */
    let drawerEl = null;
    for (const row of rows) {
      if (row.kind === 'header') {
        const section = make('section', 'picker-section');
        section.dataset.section = row.section.id;
        const head = make('div', 'picker-section-head');
        head.appendChild(make('span', 'picker-section-title', row.section.title));
        section.appendChild(head);
        grid.appendChild(section);
        container = section;
        combEl = null;
        drawerEl = null;
        continue;
      }
      let parent;
      if (row.drawerOf) {
        if (!drawerEl || drawerEl.dataset.family !== row.drawerOf) {
          drawerEl = make('div', 'picker-drawer');
          drawerEl.dataset.family = row.drawerOf;
          drawerEl.setAttribute('role', 'group');
          const family = model.families.get(row.drawerOf);
          if (family) drawerEl.setAttribute('aria-label', family.name);
          container.appendChild(drawerEl);
          combEl = null;
        }
        parent = drawerEl;
      } else {
        if (!combEl) {
          combEl = make('div', 'picker-comb');
          container.appendChild(combEl);
          drawerEl = null;
        }
        parent = combEl;
      }
      const rowEl = make('div', row.indent ? 'picker-row indent' : 'picker-row');
      rowEl.setAttribute('role', 'row');
      const ctx = container.dataset && container.dataset.section === RECENT_SECTION_ID ? 'r' : 'm';
      for (const entry of row.cells) {
        const cell = cellFor(entry, ctx);
        cell.setAttribute('tabindex', '-1');
        if (entry.type === 'family') {
          const open = state.openFamily === entry.key && !state.showAll;
          cell.classList.toggle('open', open);
          cell.setAttribute('aria-expanded', open ? 'true' : 'false');
          const chev = cell.querySelector('.picker-chevron');
          if (chev) chev.textContent = open ? '▾' : '▸';
          cell.title = familyLine(entry, open);
        }
        cell.classList.toggle('in-drawer', Boolean(row.drawerOf));
        rowEl.appendChild(cell);
        flat.push(cell);
      }
      parent.appendChild(rowEl);
    }
    state.focusIndex = Math.max(0, Math.min(flat.length - 1, state.focusIndex));
    const keep = focusedEl ? flat.indexOf(focusedEl) : -1;
    if (keep >= 0) state.focusIndex = keep;
    if (flat.length > 0) flat[state.focusIndex].setAttribute('tabindex', '0');
    if (hadFocus && flat[state.focusIndex]) focusEl(flat[state.focusIndex]);
    if (state.hoverCell && !grid.contains(state.hoverCell)) clearHover();
    markHotbar();
    updateRail();
  }

  /** Move the roving focus to cell `i` and show it (scrolled into view, nearest edge). @param {number} i */
  function focusCell(i, behavior = 'smooth') {
    if (flat.length === 0) return;
    const j = Math.max(0, Math.min(flat.length - 1, i));
    const prev = flat[state.focusIndex];
    if (prev) prev.setAttribute('tabindex', '-1');
    state.focusIndex = j;
    const cell = flat[j];
    cell.setAttribute('tabindex', '0');
    focusEl(cell);
    setHover(cell);
    reveal(cell, /** @type {'smooth'|'auto'} */ (behavior));
  }

  // ---- families -----------------------------------------------------------------------------------------------------------

  /**
   * Open `key` (closing any other) or, when it is the open one, close it. Focus stays on (or returns to) the tile, or moves
   * into the drawer when `enter` is set.
   * @param {string} key @param {{ enter?: boolean, focus?: boolean }} [opts]
   */
  function toggleFamily(key, opts = {}) {
    if (state.showAll) return;
    const opening = state.openFamily !== key;
    state.openFamily = opening ? key : null;
    const tile = cellCache.get(`fam:${key}`) || null;
    render();
    const ti = tile ? flat.indexOf(tile) : -1;
    if (opening) {
      const drawer = /** @type {HTMLElement|null} */ (grid.querySelector('.picker-drawer'));
      if (opts.enter && ti >= 0) focusCell(ti + firstDrawerOffset(ti));
      else if (opts.focus && ti >= 0) focusCell(ti);
      reveal(drawer);
    } else if (opts.focus && ti >= 0) {
      focusCell(ti);
    }
    if (tile && state.hoverCell === tile) setHover(tile);
  }

  /** @param {number} tileIndex @returns {number} the offset from the tile to the drawer's first cell in `flat` */
  function firstDrawerOffset(tileIndex) {
    for (let k = tileIndex + 1; k < flat.length; k++) if (flat[k].classList.contains('in-drawer')) return k - tileIndex;
    return 0;
  }

  /** @param {HTMLElement} cell @returns {string|null} the family whose drawer holds this cell */
  function drawerOfCell(cell) {
    const d = typeof cell.closest === 'function' ? cell.closest('.picker-drawer') : null;
    return d ? /** @type {HTMLElement} */ (d).dataset.family ?? null : null;
  }

  // ---- picking ------------------------------------------------------------------------------------------------------------

  /** @param {number} id @param {number|null} slot */
  function pick(id, slot) {
    state.recent = pushRecent(state.recent, id);
    if (slot !== null) {
      state.hotbar[slot] = id;
      markHotbar();
    }
    fire('onPick', id, slot);
  }

  // ---- the rail -----------------------------------------------------------------------------------------------------------

  function buildRail() {
    clear(els.pickerRail);
    railButtons.clear();
    for (const s of model.sections) {
      const b = make('button', 'picker-rail-btn');
      b.setAttribute('type', 'button');
      b.setAttribute('tabindex', '-1');
      b.dataset.section = s.id;
      b.title = s.title;
      b.setAttribute('aria-label', s.title);
      const icon = iconCanvas(s.iconId, PICKER_RAIL_ICON_PX);
      icon.className = 'picker-rail-icon';
      b.appendChild(icon);
      els.pickerRail.appendChild(b);
      railButtons.set(s.id, b);
    }
    const first = railButtons.values().next().value;
    if (first) first.setAttribute('tabindex', '0');
  }

  /** @param {string} id @returns {HTMLElement|null} */
  function sectionEl(id) {
    return /** @type {HTMLElement|null} */ (grid.querySelector(`.picker-section[data-section="${id}"]`));
  }

  /** Scroll section `id`'s header to the top of the view (smoothly). @param {string} id */
  function jumpTo(id) {
    if (normalizeQuery(state.query)) setQuery('');
    const sec = sectionEl(id);
    if (!sec) return;
    const top = Math.max(0, Number(sec.offsetTop) || 0);
    if (typeof scroll.scrollTo === 'function') scroll.scrollTo({ top, behavior: 'smooth' });
    else scroll.scrollTop = top;
    setCurrent(id);
  }

  /** The rail button of the section at the top of the view gets `.current`. */
  function updateRail() {
    if (normalizeQuery(state.query)) {
      setCurrent(null);
      return;
    }
    const top = (Number(scroll.scrollTop) || 0) + 2;
    let current = model.sections.length ? model.sections[0].id : null;
    for (const s of model.sections) {
      const sec = sectionEl(s.id);
      if (sec && (Number(sec.offsetTop) || 0) <= top) current = s.id;
    }
    setCurrent(current);
  }

  /** @param {string|null} id */
  function setCurrent(id) {
    for (const [sid, b] of railButtons) {
      const cur = sid === id;
      b.classList.toggle('current', cur);
      if (cur) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    }
  }

  // ---- search -------------------------------------------------------------------------------------------------------------

  /** @param {string} q */
  function setQuery(q) {
    const was = normalizeQuery(state.query);
    state.query = q;
    if (search.value !== q) search.value = q;
    if (normalizeQuery(q) === was && q !== '') return;
    state.focusIndex = 0;
    render();
    scroll.scrollTop = 0;
  }

  // ---- events: grid -------------------------------------------------------------------------------------------------------

  /** @param {Event} e @returns {HTMLElement|null} */
  function cellOf(e) {
    const t = /** @type {HTMLElement|null} */ (e.target);
    return t && typeof t.closest === 'function' ? /** @type {HTMLElement|null} */ (t.closest('.picker-cell')) : null;
  }

  on(grid, 'click', (e) => {
    const cell = cellOf(e);
    if (state.suppressClick) {
      state.suppressClick = false;
      return;
    }
    if (!cell) return;
    const i = flat.indexOf(cell);
    if (i >= 0) state.focusIndex = i;
    const fam = cell.dataset.family;
    if (fam !== undefined) toggleFamily(fam, { focus: doc.activeElement === cell });
    else pick(Number(cell.dataset.blockId), null);
  });
  on(grid, 'mouseover', (e) => {
    const cell = cellOf(e);
    if (cell && cell !== state.hoverCell) setHover(cell);
  });
  on(grid, 'mouseout', (e) => {
    const cell = cellOf(e);
    const to = /** @type {MouseEvent} */ (e).relatedTarget;
    if (cell && !(to && cell.contains(/** @type {Node} */ (to)))) clearHover(cell);
  });
  on(grid, 'focusin', (e) => {
    const cell = cellOf(e);
    if (!cell) return;
    const i = flat.indexOf(cell);
    if (i >= 0 && i !== state.focusIndex) {
      if (flat[state.focusIndex]) flat[state.focusIndex].setAttribute('tabindex', '-1');
      state.focusIndex = i;
      cell.setAttribute('tabindex', '0');
    }
    setHover(cell);
  });
  on(grid, 'focusout', (e) => {
    const cell = cellOf(e);
    if (cell) clearHover(cell);
  });

  // ---- events: dragging a block onto the hotbar, and dragging empty space to scroll ---------------------------------------

  /** @param {PointerEvent} e */
  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const cell = cellOf(e);
    if (cell && cell.dataset.blockId !== undefined) {
      drag = { id: Number(cell.dataset.blockId), cell, x0: e.clientX, y0: e.clientY, started: false, ghost: null, slot: null,
        pointerId: e.pointerId };
      try {
        cell.setPointerCapture(e.pointerId);
      } catch {}
      attachDragListeners();
      return;
    }
    if (cell) return; // a family tile: a click opens it
    // empty scroll background (not the native scrollbar): drag to scroll
    if (e.target === scroll && typeof scroll.getBoundingClientRect === 'function') {
      const r = scroll.getBoundingClientRect();
      const inner = (Number(scroll.clientLeft) || 0) + (Number(scroll.clientWidth) || 0);
      if (inner > 0 && e.clientX >= r.left + inner) return;
    }
    scrollDrag = { y0: e.clientY, top0: Number(scroll.scrollTop) || 0, moved: false, pointerId: e.pointerId };
    try {
      scroll.setPointerCapture(e.pointerId);
    } catch {}
    attachDragListeners();
  }

  /** @param {PointerEvent} e */
  function onPointerMove(e) {
    if (scrollDrag) {
      const dy = e.clientY - scrollDrag.y0;
      if (!scrollDrag.moved && Math.abs(dy) > DRAG_START_PX) {
        scrollDrag.moved = true;
        scroll.classList.add('grabbing');
      }
      if (scrollDrag.moved) scroll.scrollTop = scrollDrag.top0 - dy;
      return;
    }
    if (!drag) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) <= DRAG_START_PX) return;
      drag.started = true;
      const ghost = make('div', 'picker-ghost');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.appendChild(iconCanvas(drag.id, PICKER_GHOST_PX));
      (doc.body || els.blockPicker).appendChild(ghost);
      drag.ghost = ghost;
      els.blockPicker.classList.add('dragging');
    }
    if (drag.ghost) drag.ghost.style.transform = `translate(${e.clientX - PICKER_GHOST_PX / 2}px,${e.clientY - PICKER_GHOST_PX / 2}px)`;
    const slot = slotAt(e.clientX, e.clientY);
    if (slot !== drag.slot) {
      if (drag.slot) drag.slot.classList.remove('drop-target');
      if (slot) slot.classList.add('drop-target');
      drag.slot = slot;
    }
  }

  /** @param {number} x @param {number} y @returns {HTMLElement|null} the hotbar slot under the pointer */
  function slotAt(x, y) {
    if (typeof doc.elementFromPoint !== 'function') return null;
    const el = /** @type {HTMLElement|null} */ (doc.elementFromPoint(x, y));
    const slot = el && typeof el.closest === 'function' ? /** @type {HTMLElement|null} */ (el.closest('.hotbar-slot')) : null;
    return slot && slot.dataset.slot !== undefined ? slot : null;
  }

  /** @param {PointerEvent} e */
  function onPointerUp(e) {
    if (scrollDrag) {
      if (scrollDrag.moved) suppressNextClick();
      endDrags();
      return;
    }
    if (!drag) return;
    const d = drag;
    if (d.started) {
      suppressNextClick();
      const slot = e.type === 'pointerup' ? (slotAt(e.clientX, e.clientY) || d.slot) : null;
      const n = slot ? Number(slot.dataset.slot) : -1;
      endDrags();
      if (Number.isInteger(n) && n >= 0 && n < HOTBAR_SIZE) pick(d.id, n);
      return;
    }
    endDrags();
  }

  /** A drag ends with a click on the cell it started on (pointer capture): swallow that one click. */
  function suppressNextClick() {
    state.suppressClick = true;
    timers.setTimeout(() => {
      state.suppressClick = false;
    }, 0);
  }

  function attachDragListeners() {
    on(doc, 'pointermove', /** @type {EventListener} */ (onPointerMove));
    on(doc, 'pointerup', /** @type {EventListener} */ (onPointerUp));
    on(doc, 'pointercancel', /** @type {EventListener} */ (onPointerUp));
  }

  /** Drop any drag in progress: the ghost, the highlight, the listeners. */
  function endDrags() {
    if (drag) {
      if (drag.ghost && drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
      if (drag.slot) drag.slot.classList.remove('drop-target');
      try {
        drag.cell.releasePointerCapture(drag.pointerId);
      } catch {}
      drag = null;
      els.blockPicker.classList.remove('dragging');
    }
    if (scrollDrag) {
      try {
        scroll.releasePointerCapture(scrollDrag.pointerId);
      } catch {}
      scrollDrag = null;
      scroll.classList.remove('grabbing');
    }
    off(doc, 'pointermove', /** @type {EventListener} */ (onPointerMove));
    off(doc, 'pointerup', /** @type {EventListener} */ (onPointerUp));
    off(doc, 'pointercancel', /** @type {EventListener} */ (onPointerUp));
  }

  on(scroll, 'pointerdown', /** @type {EventListener} */ (onPointerDown));
  on(scroll, 'scroll', () => {
    state.scrollTop = Number(scroll.scrollTop) || 0;
    updateRail();
  });

  // ---- events: rail, search, Show all -------------------------------------------------------------------------------------

  on(els.pickerRail, 'click', (e) => {
    const t = /** @type {HTMLElement|null} */ (e.target);
    const b = t && typeof t.closest === 'function' ? /** @type {HTMLElement|null} */ (t.closest('.picker-rail-btn')) : null;
    if (b && b.dataset.section) jumpTo(b.dataset.section);
  });
  on(search, 'input', () => setQuery(String(search.value ?? '')));
  on(showAllBox, 'change', () => {
    state.showAll = Boolean(showAllBox.checked);
    render();
  });

  // ---- keyboard (document level, attached while open) ---------------------------------------------------------------------

  /** @param {KeyboardEvent} e */
  function onKeyDown(e) {
    if (!state.open || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = /** @type {HTMLElement|null} */ (e.target);
    const key = e.key;
    const code = e.code || codeFromKey(key);
    if (target === search) {
      // typing: E and the digits go into the field; only these keys act
      if (key === 'Escape' || key === 'Esc') {
        e.preventDefault();
        if (String(search.value ?? '') !== '' || state.query) setQuery('');
        else fire('onClose');
      } else if (key === 'Enter') {
        e.preventDefault();
        const first = searchBlocks(model, String(search.value ?? state.query))[0];
        if (first !== undefined) pick(first, null);
      } else if (key === 'ArrowDown') {
        e.preventDefault();
        if (flat.length) focusCell(0);
      }
      return;
    }
    if (key === '/' || code === 'Slash') {
      e.preventDefault();
      focusEl(search);
      if (typeof search.select === 'function') search.select();
      return;
    }
    if (code === 'Escape' || code === 'KeyE') {
      if (e.repeat) return;
      e.preventDefault();
      if (code === 'Escape' && normalizeQuery(state.query)) setQuery('');
      else fire('onClose');
      return;
    }
    const slot = slotFromDigitCode(code);
    if (slot >= 0) {
      if (e.repeat) return;
      const id = state.hoverId;
      if (id !== null) {
        e.preventDefault();
        pick(id, slot);
      }
      return;
    }
    // the rail: ↑ / ↓ walk its buttons (Enter / Space click them natively)
    const railBtn = target && typeof target.closest === 'function' ? /** @type {HTMLElement|null} */ (target.closest('.picker-rail-btn')) : null;
    if (railBtn && (key === 'ArrowUp' || key === 'ArrowDown')) {
      e.preventDefault();
      const list = [...railButtons.values()];
      const i = list.indexOf(railBtn) + (key === 'ArrowDown' ? 1 : -1);
      const next = list[Math.max(0, Math.min(list.length - 1, i))];
      for (const b of list) b.setAttribute('tabindex', b === next ? '0' : '-1');
      focusEl(next);
      return;
    }
    const cell = target && grid.contains(target) && typeof target.closest === 'function'
      ? /** @type {HTMLElement|null} */ (target.closest('.picker-cell')) : null;
    if (!cell) {
      if (NAV_KEYS.has(key) && !railBtn && target !== showAllBox) {
        e.preventDefault();
        focusCell(state.focusIndex);
      }
      return;
    }
    const index = flat.indexOf(cell);
    const fam = cell.dataset.family;
    const drawer = drawerOfCell(cell);
    if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
      e.preventDefault();
      if (e.repeat) return;
      if (fam !== undefined) toggleFamily(fam, { focus: true });
      else pick(Number(cell.dataset.blockId), null);
      return;
    }
    if (fam !== undefined && key === 'ArrowRight' && !state.showAll) {
      e.preventDefault();
      if (state.openFamily !== fam) toggleFamily(fam, { enter: true });
      else focusCell(index + firstDrawerOffset(index));
      return;
    }
    if (drawer && (key === 'Backspace' || (key === 'ArrowLeft' && index > 0 && !flat[index - 1].classList.contains('in-drawer')))) {
      e.preventDefault();
      toggleFamily(drawer, { focus: true });
      return;
    }
    if (NAV_KEYS.has(key)) {
      e.preventDefault();
      const page = Math.max(1, Math.floor((Number(scroll.clientHeight) || 0) / PICKER_ROW_H));
      focusCell(navigate(rows, index, key, page));
    }
  }

  /** Space activates a button on keyup: the keydown handler already acted. @param {KeyboardEvent} e */
  function onKeyUp(e) {
    if (!state.open) return;
    const t = /** @type {HTMLElement|null} */ (e.target);
    if ((e.key === ' ' || e.key === 'Spacebar') && t && grid.contains(t)) e.preventDefault();
  }

  function attachKeys() {
    if (state.keysAttached) return;
    state.keysAttached = true;
    on(doc, 'keydown', /** @type {EventListener} */ (onKeyDown));
    on(doc, 'keyup', /** @type {EventListener} */ (onKeyUp));
  }

  function detachKeys() {
    if (!state.keysAttached) return;
    state.keysAttached = false;
    off(doc, 'keydown', /** @type {EventListener} */ (onKeyDown));
    off(doc, 'keyup', /** @type {EventListener} */ (onKeyUp));
  }

  function onResize() {
    if (!state.open) return;
    const cols = measureCols();
    if (cols !== state.cols) {
      state.cols = cols;
      render();
    }
  }

  // ---- open / close -------------------------------------------------------------------------------------------------------

  /** @param {number[]} hotbar @param {number} selected */
  function show(hotbar, selected) {
    if (state.disposed) return;
    state.hotbar = Array.isArray(hotbar) ? hotbar.slice(0, HOTBAR_SIZE) : [];
    state.selected = Number.isInteger(selected) ? selected : 0;
    if (state.open) {
      markHotbar(); // a hotbar click while open: only the badges change
      return;
    }
    state.open = true;
    els.blockPicker.classList.remove('hidden');
    state.query = '';
    search.value = '';
    showAllBox.checked = state.showAll;
    state.cols = measureCols();
    clearHover();
    render();
    scroll.scrollTop = state.scrollTop;
    updateRail();
    attachKeys();
    on(win, 'resize', onResize);
  }

  function hide() {
    endDrags();
    detachKeys();
    off(win, 'resize', onResize);
    if (!state.open) {
      els.blockPicker.classList.add('hidden');
      return;
    }
    state.open = false;
    clearHover();
    els.blockPicker.classList.add('hidden');
    const active = /** @type {HTMLElement|null} */ (doc.activeElement);
    if (active && els.blockPicker.contains(active) && typeof active.blur === 'function') active.blur();
  }

  function dispose() {
    if (state.disposed) return;
    hide();
    state.disposed = true;
    for (const [t, type, fn, capture] of listeners.splice(0)) t.removeEventListener(type, fn, capture);
    clear(grid);
    clear(els.pickerRail);
    cellCache.clear();
    railButtons.clear();
    flat = [];
  }

  buildRail();
  els.pickerName.textContent = NAME_IDLE;

  return {
    show,
    hide,
    isOpen: () => state.open,
    dispose,
  };
}
