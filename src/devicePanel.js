// Caelancraft — the device panel: the settings, live reading and history of one circuit part, opened with the Shift+R key.
// docs/DESIGN-circuits.md §4.10, §6.2.15 (CONTRACTS §57 once merged).
//
// Main opens it in STATE.DEVICE (controls disabled, the pointer unlocked; set before controls.unlock(), pitfall 24) with
// `circuits.panelView(q, y, r, creative)`. In Creative the world is frozen behind it, as behind the rune editor; in Survival it
// keeps stepping, as behind the pack screen, so the panel never works as a pause button. Every change goes straight to main
// through onChange(key, partial) (store field names: l, on, nc, f, s, m, ch), which applies it with circuits.applySettings and
// calls refresh(view); buttons send onAction(key, 'start'|'stop'|'send'|'tap'|'refill'). Done, Esc, Enter in a field and the
// Shift+R key close it through onClose. If the cell stops being that part while the panel is open, main closes it.
//
// Look: the survival palette (dark #1c1a24, honey #e8b04a, ember #d0582a, text #f3ead8). Every button and segmented control
// is survival's `.hex-button`; `.cc-panel` is only the container. Never `.mc-button` or `.picker-panel` (tested).
//
// DOM module: nothing touches the document at module top level, so the pure helpers (panelFields, clampSetting) and the panel
// itself can be tested under Node on a fake DOM. Imports: config, circuitParts, circuitStore (normalizePart's rules), circuits
// (the battery's volts) and atlas (the header icon).
// CONTRACT-ISSUE: §6.1's import graph lists `devicePanel → config, circuitParts` only. clampSetting "delegates to
// circuitStore.normalizePart rules" (§6.2.15), the charge bar shows the battery's volts by the engine's own curve (circuits'
// batteryUnits / formatVolts, both pure) and the header draws the part's icon (atlas): three more edges, still acyclic.
// circuits.panelView also leaves `fields` empty for a part with no store entry, so the panel fills in defaultPart(k).
import {
  MAX_PART_LABEL_CHARS, TIMER_MIN_S, TIMER_MAX_S, RADIO_CHANNELS, RADIO_DISTRESS_CH, BATTERY_CAPACITY,
} from './config.js';
import { partByKey, wavelengthOf } from './circuitParts.js';
import { defaultPart, normalizePart } from './circuitStore.js';
import { batteryUnits, formatVolts } from './circuits.js';
import { drawBlockIcon } from './atlas.js';

/** @typedef {import('./types.js').DevicePanelView} DevicePanelView */

/** Typing in the label field reaches main after this many ms of quiet (and at once on Enter, Done or close). */
export const LABEL_DEBOUNCE_MS = 250;
/** The header icon. */
export const PANEL_ICON_PX = 48;
/** The Clockwork Timer's preset chips, like a time switch's dial: 5 · 10 · 15 · 30 s · 1 · 5 min (§4.10). */
export const TIMER_PRESETS = Object.freeze([
  Object.freeze({ value: 5, label: '5 s' }),
  Object.freeze({ value: 10, label: '10 s' }),
  Object.freeze({ value: 15, label: '15 s' }),
  Object.freeze({ value: 30, label: '30 s' }),
  Object.freeze({ value: 60, label: '1 min' }),
  Object.freeze({ value: 300, label: '5 min' }),
]);
/** Button labels of the actions a view may offer. */
export const ACTION_LABELS = Object.freeze({ start: 'Start', stop: 'Stop', send: 'Send', tap: 'Tap', refill: 'Refill' });
/** The six side faces as the input-face picker names them (hex.js numbering, north up: +X east, +Z south). */
export const FACE_NAMES = Object.freeze(['E', 'SE', 'SW', 'W', 'NW', 'NE', 'top']);
/** The keys and their meaning, at the foot of the panel. */
export const PANEL_KEYS_HINT = 'Esc, Enter or the Shift+R key: done';

/**
 * @typedef {{ value: *, label: string, distress?: boolean }} FieldOption
 * @typedef {(
 *   { kind: 'label', field: 'l', value: string, max: number } |
 *   { kind: 'number', field: 's', label: string, value: number, min: number, max: number, step: number, unit: string } |
 *   { kind: 'presets', field: 's', value: number, options: FieldOption[] } |
 *   { kind: 'segmented', field: 'm'|'nc'|'on', label: string, value: *, options: FieldOption[] } |
 *   { kind: 'face', field: 'f', label: string, value: number } |
 *   { kind: 'dial', field: 'ch', label: string, value: number, options: FieldOption[] } |
 *   { kind: 'charge', field: 'c', label: string, value: number, percent: number, volts: string } |
 *   { kind: 'action', action: 'start'|'stop'|'send'|'tap'|'refill', label: string }
 * )} PanelField
 */

/** @returns {boolean} the part is a wire, a fuse or the torch: its panel shows only "About" (§4.9) */
function aboutOnly(k) {
  const def = partByKey(k);
  return !def || def.role === 'wire' || def.role === 'fuse' || def.role === 'flame';
}

/**
 * The view's setting values with the kind's defaults filled in (a part with no store entry has no `fields`).
 * @param {DevicePanelView} view
 * @returns {Record<string, *>}
 */
function settingsOf(view) {
  const base = defaultPart(view.k) || {};
  /** @type {Record<string, *>} */
  const out = { ...base, ...(view.fields || {}) };
  if (typeof view.label === 'string') out.l = view.label;
  return out;
}

/**
 * Which controls the panel shows for a view, in order (§4.10): the label (when the kind has one), then by kind
 * - Clockwork Timer: the delay (0.5–3600 s, step 0.5), the preset chips, `Pulse | Hold | Repeat`, the input face;
 * - Relay: `NO | NC` and the input face; Push Button: `NO | NC`;
 * - Spark Transmitter: the wavelength dial (16 hex buttons, 300…1050 m, 600 m marked distress);
 * - Coherer Receiver: the dial, `Pulse | Latch` and the input face (the tapper);
 * - Knife Switch: `Open | Closed`; Voltaic Battery: the charge bar;
 * then one button per action the view offers (Start / Stop, Send, Tap, Refill — Refill only in Creative). Wires, fuses and
 * the torch show nothing but "About": an empty list. Pure.
 * @param {DevicePanelView} view
 * @returns {PanelField[]}
 */
export function panelFields(view) {
  if (!view || aboutOnly(view.k)) return [];
  const def = /** @type {NonNullable<ReturnType<typeof partByKey>>} */ (partByKey(view.k));
  const v = settingsOf(view);
  /** @type {PanelField[]} */
  const out = [];
  if (def.fields.includes('l')) out.push({ kind: 'label', field: 'l', value: String(v.l ?? ''), max: MAX_PART_LABEL_CHARS });
  const noNc = [{ value: false, label: 'NO' }, { value: true, label: 'NC' }];
  switch (view.k) {
    case 'timer':
      out.push({ kind: 'number', field: 's', label: 'Delay', value: Number(v.s), min: TIMER_MIN_S, max: TIMER_MAX_S, step: 0.5, unit: 's' });
      out.push({ kind: 'presets', field: 's', value: Number(v.s), options: TIMER_PRESETS.map((p) => ({ ...p })) });
      out.push({ kind: 'segmented', field: 'm', label: 'Mode', value: v.m,
        options: [{ value: 'pulse', label: 'Pulse' }, { value: 'hold', label: 'Hold' }, { value: 'repeat', label: 'Repeat' }] });
      out.push({ kind: 'face', field: 'f', label: 'Input face', value: Number(v.f) });
      break;
    case 'relay':
      out.push({ kind: 'segmented', field: 'nc', label: 'Contacts', value: Boolean(v.nc), options: noNc });
      out.push({ kind: 'face', field: 'f', label: 'Input face', value: Number(v.f) });
      break;
    case 'button':
      out.push({ kind: 'segmented', field: 'nc', label: 'Contacts', value: Boolean(v.nc), options: noNc });
      break;
    case 'tx':
      out.push(dialField(Number(v.ch)));
      break;
    case 'rx':
      out.push(dialField(Number(v.ch)));
      out.push({ kind: 'segmented', field: 'm', label: 'Mode', value: v.m,
        options: [{ value: 'pulse', label: 'Pulse' }, { value: 'latch', label: 'Latch' }] });
      out.push({ kind: 'face', field: 'f', label: 'Tapper face', value: Number(v.f) });
      break;
    case 'switch':
      out.push({ kind: 'segmented', field: 'on', label: 'Blade', value: Boolean(v.on),
        options: [{ value: false, label: 'Open' }, { value: true, label: 'Closed' }] });
      break;
    case 'battery': {
      const c = Math.max(0, Math.min(BATTERY_CAPACITY, Number(v.c)));
      out.push({ kind: 'charge', field: 'c', label: 'Charge', value: c, percent: Math.floor((c / BATTERY_CAPACITY) * 100),
        volts: formatVolts(batteryUnits(c)) });
      break;
    }
    default:
      break;
  }
  for (const a of Array.isArray(view.actions) ? view.actions : []) {
    if (Object.prototype.hasOwnProperty.call(ACTION_LABELS, a)) out.push({ kind: 'action', action: a, label: ACTION_LABELS[a] });
  }
  return out;
}

/** @param {number} ch @returns {PanelField} the wavelength dial: 16 buttons, 300…1050 m, 600 m the distress wavelength */
function dialField(ch) {
  /** @type {FieldOption[]} */
  const options = [];
  for (let c = 1; c <= RADIO_CHANNELS; c++) {
    options.push({ value: c, label: String(wavelengthOf(c)), ...(c === RADIO_DISTRESS_CH ? { distress: true } : {}) });
  }
  return { kind: 'dial', field: 'ch', label: 'Wavelength', value: ch, options };
}

/**
 * A setting value as the store keeps it (circuitStore.normalizePart's rules): `s` clamped to 0.5–3600 in 0.5 s steps, `ch`
 * to 1–16, `f` to 0–6, `c` to 0–BATTERY_CAPACITY, `l` trimmed to 24 characters, `m` one of the kind's modes; an invalid value
 * gives the kind's default. Undefined when the kind has no such field. Pure.
 * @param {string} k @param {string} field @param {*} value
 */
export function clampSetting(k, field, value) {
  const def = partByKey(k);
  if (!def || !def.fields.includes(field)) return undefined;
  const out = normalizePart(k, { [field]: value });
  return out ? out[field] : undefined;
}

/**
 * The view's readout lines split for the panel: "Volts: 4.75 V" → ['Volts', '4.75 V']; a line with no "label: " → ['', line].
 * @param {string[]} lines
 * @returns {[string, string][]}
 */
export function readoutPairs(lines) {
  return (Array.isArray(lines) ? lines : []).map((line) => {
    const s = String(line);
    const m = /^([A-Z][\w-]*(?: [\w-]+)?): (.+)$/.exec(s);
    return m ? [m[1], m[2]] : ['', s];
  });
}

/**
 * @typedef {Object} DevicePanelCallbacks
 * @property {(key: string, partial: Record<string, *>) => void} [onChange]   a setting changed (store field names)
 * @property {(key: string, action: string) => void} [onAction]              Start / Stop / Send / Tap / Refill
 * @property {() => void} [onClose]                                           Done, Esc, Enter in a field, the Shift+R key
 */

/**
 * @typedef {Object} DevicePanel
 * @property {(view: DevicePanelView) => void} open
 * @property {(view: DevicePanelView|null) => void} refresh   keep the panel in step (a view of another cell is ignored)
 * @property {() => void} close
 * @property {() => boolean} isOpen
 * @property {() => string|null} getKey
 * @property {() => void} dispose
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Bind the device panel to `#device-panel` (created in `doc.body` when index.html has none).
 * @param {Document} doc
 * @param {DevicePanelCallbacks} [callbacks]
 * @param {HTMLCanvasElement|null} [atlasCanvas]  draws the header icon (a plain honey hex without it).
 *   CONTRACT-ISSUE: §6.2.15's createDevicePanel(doc, callbacks) has no atlas, but §4.10 asks for the part's 48 px icon; the
 *   atlas is an optional third argument.
 * @returns {DevicePanel}
 */
export function createDevicePanel(doc, callbacks = {}, atlasCanvas = null) {
  const win = doc.defaultView || globalThis;
  /** Timers through the document's window (a test's window stand-in may have none: then the global ones). */
  const timers = typeof win.setTimeout === 'function' ? win : globalThis;
  let layer = /** @type {HTMLElement|null} */ (doc.getElementById('device-panel'));
  if (!layer) {
    layer = doc.createElement('div');
    layer.id = 'device-panel';
    layer.className = 'layer hidden';
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-label', 'Device settings');
    (doc.body || doc.documentElement).appendChild(layer);
  }
  const root = /** @type {HTMLElement} */ (layer);

  let isOpenFlag = false;
  let disposed = false;
  /** @type {DevicePanelView|null} */
  let view = null;
  /** @type {number|null} */
  let labelTimer = null;
  /** @type {string|null} the label as last sent */
  let labelSent = null;
  /** @type {Array<() => void>} re-sync the controls from `view` */
  let syncers = [];
  /** @type {Array<[EventTarget, string, EventListener, boolean]>} */
  const listeners = [];
  /** the shape the settings were built for: rebuilt when it changes (another kind, other actions) */
  let shape = '';
  /** @type {Record<string, HTMLElement>} */
  const part = {};
  /** @type {Map<Element, string>} each input-face picker's field, for its arrow keys */
  const faceFields = new Map();

  function on(target, type, fn, capture = false) {
    target.addEventListener(type, fn, capture);
    listeners.push([target, type, fn, capture]);
  }
  function fire(name, ...args) {
    const fn = callbacks ? callbacks[name] : undefined;
    if (typeof fn === 'function') fn(...args);
  }
  /** @param {string} tag @param {string} [className] @param {string} [text] */
  function make(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  /** @param {string} tag @param {Record<string, string|number>} [attrs] */
  function svg(tag, attrs = {}) {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  }
  /** A `.hex-button` (every button in the panel is one). @param {string} text @param {string} [extra] */
  function hexButton(text, extra = '') {
    const b = make('button', `hex-button${extra ? ' ' + extra : ''}`, text);
    b.setAttribute('type', 'button');
    return b;
  }
  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  /** Send a partial at once, and show it now (main's refresh follows with the truth). @param {Record<string, *>} partial */
  function change(partial) {
    if (!view) return;
    const k = view.k;
    /** @type {Record<string, *>} */
    const clean = {};
    for (const [f, v] of Object.entries(partial)) {
      const c = clampSetting(k, f, v);
      if (c !== undefined) clean[f] = c;
    }
    if (Object.keys(clean).length === 0) return;
    view = { ...view, fields: { ...(view.fields || {}), ...clean }, ...(clean.l !== undefined ? { label: clean.l } : {}) };
    fire('onChange', view.key, clean);
    for (const s of syncers) s();
  }

  /** The label field's text reaches main now (typing is debounced). */
  function flushLabel() {
    if (labelTimer !== null) {
      timers.clearTimeout(labelTimer);
      labelTimer = null;
    }
    const input = /** @type {HTMLInputElement|undefined} */ (part.labelInput);
    if (!view || !input || input.isConnected === false) return;
    const value = String(input.value ?? '');
    if (value === labelSent) return;
    labelSent = value;
    change({ l: value });
  }

  // ---- building -----------------------------------------------------------------------------------------------------------

  /** @param {DevicePanelView} v */
  function shapeOf(v) {
    return `${v.key}|${v.k}|${panelFields(v).map((f) => f.kind === 'action' ? 'a:' + f.action : f.kind).join(',')}`;
  }

  function build() {
    if (!view) return;
    clear(root);
    syncers = [];
    faceFields.clear();
    for (const k of Object.keys(part)) delete part[k];
    const v = view;
    const fields = panelFields(v);
    const panel = make('div', 'cc-panel');
    panel.dataset.kind = v.k;
    root.appendChild(panel);

    // 1. the header: icon, name, cell, label
    const head = make('div', 'cc-head');
    const iconBox = make('div', 'cc-icon');
    const icon = /** @type {HTMLCanvasElement} */ (make('canvas'));
    icon.width = PANEL_ICON_PX;
    icon.height = PANEL_ICON_PX;
    if (atlasCanvas) {
      try {
        const ctx = icon.getContext('2d');
        if (ctx) drawBlockIcon(ctx, atlasCanvas, v.id, PANEL_ICON_PX);
      } catch {}
    }
    iconBox.appendChild(icon);
    head.appendChild(iconBox);
    const titles = make('div', 'cc-titles');
    titles.appendChild(make('div', 'cc-title', v.title));
    titles.appendChild(make('div', 'cc-coords', v.coords));
    head.appendChild(titles);
    const labelField = fields.find((f) => f.kind === 'label');
    if (labelField && labelField.kind === 'label') {
      const wrap = make('label', 'cc-label');
      wrap.appendChild(make('span', 'cc-label-text', 'Label'));
      const input = /** @type {HTMLInputElement} */ (make('input', 'cc-label-input'));
      input.setAttribute('type', 'text');
      input.setAttribute('maxlength', String(labelField.max));
      input.setAttribute('placeholder', 'name it');
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('spellcheck', 'false');
      input.value = labelField.value;
      labelSent = labelField.value;
      wrap.appendChild(input);
      head.appendChild(wrap);
      part.labelInput = input;
      on(input, 'input', () => {
        if (labelTimer !== null) timers.clearTimeout(labelTimer);
        labelTimer = timers.setTimeout(() => {
          labelTimer = null;
          flushLabel();
        }, LABEL_DEBOUNCE_MS);
      });
      on(input, 'change', flushLabel);
      syncers.push(() => {
        if (doc.activeElement !== input && labelTimer === null) {
          input.value = view ? String(view.label ?? '') : '';
          labelSent = input.value;
        }
      });
    }
    panel.appendChild(head);

    // 2. the live readout
    if (!aboutOnly(v.k)) {
      const sec = make('div', 'cc-section cc-readout');
      sec.appendChild(make('div', 'cc-heading', 'Reading'));
      const list = make('dl', 'cc-lines');
      sec.appendChild(list);
      panel.appendChild(sec);
      const fill = () => {
        clear(list);
        for (const [label, value] of readoutPairs(view ? view.readout : [])) {
          list.appendChild(make('dt', '', label));
          list.appendChild(make('dd', '', value));
        }
      };
      fill();
      syncers.push(fill);
    }

    // 3. the settings
    const controls = fields.filter((f) => f.kind !== 'label');
    if (controls.length > 0) {
      const sec = make('div', 'cc-section cc-settings');
      sec.appendChild(make('div', 'cc-heading', 'Settings'));
      /** @type {HTMLElement|null} */
      let actionsRow = null;
      /** @type {HTMLElement|null} */
      let lastBody = null;
      for (const f of controls) {
        if (f.kind === 'action') {
          if (!actionsRow) {
            actionsRow = make('div', 'cc-row cc-actions');
            sec.appendChild(actionsRow);
          }
          actionsRow.appendChild(buildAction(f));
          continue;
        }
        if (f.kind === 'presets') {
          (lastBody || sec).appendChild(buildPresets(f)); // under the delay it sets
          continue;
        }
        const row = make('div', 'cc-row');
        row.dataset.field = f.field;
        row.appendChild(make('span', 'cc-row-label', f.label));
        const body = make('div', 'cc-row-body');
        row.appendChild(body);
        lastBody = body;
        if (f.kind === 'number') body.appendChild(buildNumber(f));
        else if (f.kind === 'segmented') body.appendChild(buildSegmented(f));
        else if (f.kind === 'face') body.appendChild(buildFace(f));
        else if (f.kind === 'dial') body.appendChild(buildDial(f));
        else if (f.kind === 'charge') body.appendChild(buildCharge(f));
        sec.appendChild(row);
      }
      panel.appendChild(sec);
    }

    // 4. About: the real thing and the tip, in honey italic
    const about = make('div', 'cc-section cc-about');
    about.appendChild(make('div', 'cc-heading', 'About'));
    if (v.origin) about.appendChild(make('p', 'cc-origin', v.origin));
    about.appendChild(make('p', 'cc-tip', v.about || ''));
    panel.appendChild(about);

    // 5. Done
    const foot = make('div', 'cc-foot');
    foot.appendChild(make('span', 'cc-keys', PANEL_KEYS_HINT));
    const done = hexButton('Done', 'cc-done');
    on(done, 'click', () => requestClose());
    foot.appendChild(done);
    panel.appendChild(foot);
    part.done = done;
    shape = shapeOf(v);
  }

  /** @returns {*} the current value of a field (with the kind's default) */
  function current(field) {
    return view ? settingsOf(view)[field] : undefined;
  }

  /** @param {Extract<PanelField, { kind: 'number' }>} f */
  function buildNumber(f) {
    const wrap = make('span', 'cc-number');
    const input = /** @type {HTMLInputElement} */ (make('input', 'cc-number-input'));
    input.setAttribute('type', 'number');
    input.setAttribute('min', String(f.min));
    input.setAttribute('max', String(f.max));
    input.setAttribute('step', String(f.step));
    input.setAttribute('aria-label', `${f.label} in seconds`);
    input.value = String(f.value);
    wrap.appendChild(input);
    wrap.appendChild(make('span', 'cc-unit', f.unit));
    part[`number:${f.field}`] = input;
    on(input, 'change', () => commitNumber(input, f.field));
    syncers.push(() => {
      if (doc.activeElement !== input) input.value = String(current(f.field));
    });
    return wrap;
  }

  /** @param {HTMLInputElement} input @param {string} field */
  function commitNumber(input, field) {
    const n = Number(String(input.value ?? '').trim().replace(',', '.'));
    if (String(input.value ?? '').trim() === '' || !Number.isFinite(n)) {
      input.value = String(current(field));
      return;
    }
    const v = clampSetting(view ? view.k : '', field, n);
    input.value = String(v);
    if (v !== current(field)) change({ [field]: v });
  }

  /** @param {Extract<PanelField, { kind: 'presets' }>} f */
  function buildPresets(f) {
    const chips = make('div', 'cc-chips');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'Presets');
    /** @type {[HTMLElement, number][]} */
    const items = [];
    for (const o of f.options) {
      const b = hexButton(o.label, 'cc-chip');
      b.dataset.value = String(o.value);
      on(b, 'click', () => change({ [f.field]: o.value }));
      chips.appendChild(b);
      items.push([b, o.value]);
    }
    const sync = () => {
      const cur = Number(current(f.field));
      for (const [b, value] of items) {
        b.classList.toggle('active', value === cur);
        b.setAttribute('aria-pressed', value === cur ? 'true' : 'false');
      }
    };
    sync();
    syncers.push(sync);
    return chips;
  }

  /** @param {Extract<PanelField, { kind: 'segmented' }>} f */
  function buildSegmented(f) {
    const group = make('div', 'cc-seg');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', f.label);
    group.dataset.field = f.field;
    /** @type {[HTMLElement, *][]} */
    const items = [];
    for (const o of f.options) {
      const b = hexButton(o.label, 'cc-seg-btn');
      b.dataset.value = String(o.value);
      on(b, 'click', () => {
        if (current(f.field) !== o.value) change({ [f.field]: o.value });
      });
      group.appendChild(b);
      items.push([b, o.value]);
    }
    const sync = () => {
      const cur = current(f.field);
      for (const [b, value] of items) {
        b.classList.toggle('active', value === cur);
        b.setAttribute('aria-pressed', value === cur ? 'true' : 'false');
      }
    };
    sync();
    syncers.push(sync);
    return group;
  }

  /**
   * The input face picker: a small SVG hex of six side wedges plus a top dot, north up, the current face in honey. ←/→
   * walk the faces when it has the focus.
   * @param {Extract<PanelField, { kind: 'face' }>} f
   */
  function buildFace(f) {
    const wrap = make('div', 'cc-face');
    const R = 40;
    const root = svg('svg', { viewBox: '-46 -46 92 92', width: 80, height: 80, class: 'cc-face-svg', role: 'radiogroup',
      tabindex: 0, 'aria-label': f.label });
    const corner = (k) => {
      const a = (Math.PI / 3) * k - Math.PI / 6;
      return [R * Math.cos(a), R * Math.sin(a)];
    };
    /** @type {[Element, number][]} */
    const items = [];
    for (let j = 0; j < 6; j++) {
      const [x0, y0] = corner(j);
      const [x1, y1] = corner(j + 1);
      const g = svg('g', { class: 'cc-wedge', role: 'radio', 'data-face': j, 'aria-label': `${FACE_NAMES[j]} side (face ${j})` });
      g.appendChild(svg('polygon', { points: `0,0 ${x0.toFixed(2)},${y0.toFixed(2)} ${x1.toFixed(2)},${y1.toFixed(2)}` }));
      const a = (Math.PI / 3) * j;
      const t = svg('text', { x: (R * 0.62 * Math.cos(a)).toFixed(2), y: (R * 0.62 * Math.sin(a) + 3.5).toFixed(2), 'text-anchor': 'middle' });
      t.textContent = FACE_NAMES[j];
      g.appendChild(t);
      root.appendChild(g);
      items.push([g, j]);
    }
    const top = svg('g', { class: 'cc-wedge cc-top', role: 'radio', 'data-face': 6, 'aria-label': 'top (face 6)' });
    top.appendChild(svg('circle', { cx: 0, cy: 0, r: 10 }));
    const tt = svg('text', { x: 0, y: 3, 'text-anchor': 'middle' });
    tt.textContent = 'top';
    top.appendChild(tt);
    root.appendChild(top);
    items.push([top, 6]);
    wrap.appendChild(root);
    const caption = make('span', 'cc-face-caption');
    wrap.appendChild(caption);
    on(root, 'click', (e) => {
      const t = /** @type {Element|null} */ (e.target);
      const g = t && typeof t.closest === 'function' ? t.closest('[data-face]') : null;
      if (!g) return;
      const face = Number(g.getAttribute('data-face'));
      if (Number.isInteger(face) && face !== current(f.field)) change({ [f.field]: face });
    });
    faceFields.set(root, f.field);
    const sync = () => {
      const cur = Number(current(f.field));
      for (const [g, face] of items) {
        g.setAttribute('class', `cc-wedge${face === 6 ? ' cc-top' : ''}${face === cur ? ' active' : ''}`);
        g.setAttribute('aria-checked', face === cur ? 'true' : 'false');
      }
      caption.textContent = `${FACE_NAMES[cur] ?? '?'}${cur === 6 ? '' : ' side'} · north is up`;
    };
    sync();
    syncers.push(sync);
    return wrap;
  }

  /** The wavelength dial: 16 small hex buttons in two rows of 8, the 600 m one marked distress. @param {Extract<PanelField, { kind: 'dial' }>} f */
  function buildDial(f) {
    const wrap = make('div', 'cc-dial');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Wavelength in metres');
    /** @type {[HTMLElement, number][]} */
    const items = [];
    for (let row = 0; row < 2; row++) {
      const r = make('div', 'cc-dial-row');
      for (const o of f.options.slice(row * 8, row * 8 + 8)) {
        const b = hexButton(o.label, `cc-wave${o.distress ? ' distress' : ''}`);
        b.dataset.value = String(o.value);
        b.title = o.distress ? `${o.label} m — the distress wavelength` : `${o.label} m`;
        on(b, 'click', () => {
          if (current(f.field) !== o.value) change({ [f.field]: o.value });
        });
        r.appendChild(b);
        items.push([b, o.value]);
      }
      wrap.appendChild(r);
    }
    const legend = make('div', 'cc-dial-legend');
    legend.appendChild(make('span', 'cc-dial-unit', 'metres'));
    legend.appendChild(make('span', 'cc-distress-mark', '600 m: distress'));
    wrap.appendChild(legend);
    const sync = () => {
      const cur = Number(current(f.field));
      for (const [b, value] of items) {
        b.classList.toggle('active', value === cur);
        b.setAttribute('aria-pressed', value === cur ? 'true' : 'false');
      }
    };
    sync();
    syncers.push(sync);
    return wrap;
  }

  /** The battery's charge bar with its volts. @param {Extract<PanelField, { kind: 'charge' }>} f */
  function buildCharge(f) {
    const wrap = make('div', 'cc-charge');
    wrap.setAttribute('role', 'meter');
    wrap.setAttribute('aria-valuemin', '0');
    wrap.setAttribute('aria-valuemax', '100');
    const fill = make('div', 'cc-charge-fill');
    const text = make('span', 'cc-charge-text');
    wrap.appendChild(fill);
    wrap.appendChild(text);
    const sync = () => {
      const g = view ? panelFields(view).find((x) => x.kind === 'charge') : null;
      const c = g && g.kind === 'charge' ? g : f;
      fill.style.width = `${c.percent}%`;
      fill.classList.toggle('low', c.percent < 25);
      text.textContent = `${c.percent} % · ${c.volts}`;
      wrap.setAttribute('aria-valuenow', String(c.percent));
    };
    sync();
    syncers.push(sync);
    return wrap;
  }

  /** @param {Extract<PanelField, { kind: 'action' }>} f */
  function buildAction(f) {
    const b = hexButton(f.label, `cc-action cc-action-${f.action}`);
    b.dataset.action = f.action;
    on(b, 'click', () => {
      if (view) fire('onAction', view.key, f.action);
    });
    return b;
  }

  // ---- open / refresh / close -------------------------------------------------------------------------------------------

  function requestClose() {
    if (!isOpenFlag) return;
    flushOpenInputs();
    fire('onClose');
  }

  /** Commit the label and a delay being typed. */
  function flushOpenInputs() {
    flushLabel();
    const num = /** @type {HTMLInputElement|undefined} */ (part['number:s']);
    if (num && doc.activeElement === num) commitNumber(num, 's');
  }

  /** @param {KeyboardEvent} e */
  function onKeyDown(e) {
    if (!isOpenFlag) return;
    const t = /** @type {HTMLElement|null} */ (e.target);
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      requestClose();
    } else if (e.key === 'Enter' && typing) {
      e.preventDefault();
      requestClose();
    } else if ((e.code === 'KeyR' || e.key === 'R' || e.key === 'r') && e.shiftKey && !typing && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      requestClose();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && t && typeof t.closest === 'function') {
      // ←/→ on an input-face picker walk the faces 0..5 and the top (6)
      const pickerEl = t.closest('.cc-face-svg');
      const field = pickerEl ? faceFields.get(pickerEl) : undefined;
      if (field) {
        e.preventDefault();
        const cur = Number(current(field)) || 0;
        change({ [field]: (cur + (e.key === 'ArrowRight' ? 1 : 6)) % 7 });
      }
    }
    // keys typed into the panel never reach the game (its controls are disabled anyway)
    e.stopPropagation();
  }
  on(doc, 'keydown', /** @type {EventListener} */ (onKeyDown), true);

  /** @param {DevicePanelView} v */
  function open(v) {
    if (disposed || !v) return;
    if (isOpenFlag && view && view.key !== v.key) flushOpenInputs();
    view = { ...v };
    build();
    isOpenFlag = true;
    root.classList.remove('hidden');
    const first = /** @type {HTMLElement|undefined} */ (part.labelInput || part.done);
    timers.setTimeout(() => {
      if (!isOpenFlag || !first) return;
      try {
        first.focus({ preventScroll: true });
      } catch {}
    }, 0);
  }

  /** @param {DevicePanelView|null} v */
  function refresh(v) {
    if (!isOpenFlag || !v || !view || v.key !== view.key) return;
    view = { ...v };
    if (shapeOf(view) !== shape) {
      const hadFocusInside = root.contains(/** @type {Node} */ (doc.activeElement));
      const active = /** @type {HTMLElement|null} */ (doc.activeElement);
      const keepLabel = part.labelInput && active === part.labelInput ? /** @type {HTMLInputElement} */ (part.labelInput).value : null;
      build();
      if (keepLabel !== null && part.labelInput) {
        /** @type {HTMLInputElement} */ (part.labelInput).value = keepLabel;
        part.labelInput.focus();
      } else if (hadFocusInside && part.done) {
        try {
          part.done.focus({ preventScroll: true });
        } catch {}
      }
      return;
    }
    for (const s of syncers) s();
  }

  function close() {
    if (!isOpenFlag) return;
    flushLabel();
    isOpenFlag = false;
    root.classList.add('hidden');
    const active = /** @type {HTMLElement|null} */ (doc.activeElement);
    if (active && root.contains(active) && typeof active.blur === 'function') active.blur();
    view = null;
    labelSent = null;
    syncers = [];
  }

  return {
    open,
    refresh,
    close,
    isOpen: () => isOpenFlag,
    getKey: () => (view ? view.key : null),
    dispose() {
      if (disposed) return;
      close();
      disposed = true;
      for (const [t, type, fn, capture] of listeners.splice(0)) t.removeEventListener(type, fn, capture);
      clear(root);
    },
  };
}
