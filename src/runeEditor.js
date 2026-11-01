// Caelancraft — the Rune Block editor panel: script, label and the four trigger options. See src/CONTRACTS.md §28.
//
// DOM module. Opened by main in the `editor` state (controls disabled, pointer unlocked, simulation frozen).
// Nothing is ever lost: every edit is pushed to main through `onChange` (debounced for typing, immediate for the
// checkboxes/numbers), so Esc, Done and Run all keep the text; `Revert` restores what the rune held when the
// editor opened. Parse errors are shown live with line numbers.
import { MAX_RUNE_SCRIPT_CHARS, MAX_RUNE_SCRIPT_LINES, MAX_RUNE_LABEL_CHARS, REPEAT_MIN_S, REPEAT_MAX_S, STEP_COOLDOWN_MAX_S } from './config.js';
import { parseScript } from './commands.js';

/** @typedef {import('./types.js').Rune} Rune */
/** @typedef {import('./runes.js').RunRecord} RunRecord */

/** Typing is pushed to the store after this many ms of quiet. */
export const EDITOR_DEBOUNCE_MS = 250;

const IDS = Object.freeze({
  layer: 'rune-editor',
  cell: 'rune-cell',
  label: 'rune-label',
  script: 'rune-script',
  counter: 'rune-counter',
  errors: 'rune-errors',
  enabled: 'rune-enabled',
  interact: 'rune-interact',
  stepOn: 'rune-stepon',
  cooldown: 'rune-cooldown',
  repeat: 'rune-repeat',
  interval: 'rune-interval',
  chain: 'rune-chain',
  lastRun: 'rune-lastrun',
  run: 'rune-run',
  done: 'rune-done',
  revert: 'rune-revert',
});

/**
 * @typedef {Object} RuneEditorCallbacks
 * @property {(key: string, partial: Partial<Rune>) => void} [onChange]   persist the current fields (called often)
 * @property {(key: string) => void} [onRun]                              Run: main saves, closes and triggers
 * @property {(key: string) => void} [onClose]                            Done / Esc: main closes
 */

/**
 * @typedef {Object} RuneEditor
 * @property {(rune: Rune, lastRun?: RunRecord|null) => void} open
 * @property {() => void} close
 * @property {() => boolean} isOpen
 * @property {() => string|null} getKey
 * @property {() => Partial<Rune>} getFields     the current field values (what onChange would send)
 * @property {() => void} dispose
 */

/**
 * @param {Document} doc
 * @param {RuneEditorCallbacks} [callbacks]
 * @returns {RuneEditor}
 */
export function createRuneEditor(doc, callbacks = {}) {
  /** @type {Record<string, HTMLElement>} */
  const el = {};
  const missing = [];
  for (const name of Object.keys(IDS)) {
    const node = doc.getElementById(IDS[name]);
    if (node) el[name] = node;
    else missing.push('#' + IDS[name]);
  }
  if (missing.length) throw new Error(`runeEditor: missing DOM element(s): ${missing.join(', ')}`);
  const win = doc.defaultView || globalThis;

  const label = /** @type {HTMLInputElement} */ (el.label);
  const script = /** @type {HTMLTextAreaElement} */ (el.script);
  const enabled = /** @type {HTMLInputElement} */ (el.enabled);
  const interact = /** @type {HTMLInputElement} */ (el.interact);
  const stepOn = /** @type {HTMLInputElement} */ (el.stepOn);
  const cooldown = /** @type {HTMLInputElement} */ (el.cooldown);
  const repeat = /** @type {HTMLInputElement} */ (el.repeat);
  const interval = /** @type {HTMLInputElement} */ (el.interval);
  const chain = /** @type {HTMLInputElement} */ (el.chain);

  label.maxLength = MAX_RUNE_LABEL_CHARS;
  script.maxLength = MAX_RUNE_SCRIPT_CHARS;
  cooldown.min = '0';
  cooldown.max = String(STEP_COOLDOWN_MAX_S);
  interval.min = String(REPEAT_MIN_S);
  interval.max = String(REPEAT_MAX_S);

  let open = false;
  let disposed = false;
  /** @type {string|null} */
  let key = null;
  /** @type {Partial<Rune>|null} what the rune held when the editor opened (for Revert) */
  let original = null;
  /** @type {number|null} */
  let debounce = null;
  /** @type {Array<[EventTarget, string, EventListener]>} */
  const listeners = [];

  function on(target, type, fn) {
    target.addEventListener(type, fn);
    listeners.push([target, type, fn]);
  }
  function fire(name, ...args) {
    const fn = callbacks ? callbacks[name] : undefined;
    if (typeof fn === 'function') fn(...args);
  }

  /** @returns {number} finite number from an input, else fallback */
  function num(input, fallback) {
    const v = Number(input.value);
    return Number.isFinite(v) && input.value.trim() !== '' ? v : fallback;
  }

  /** @returns {Partial<Rune>} */
  function getFields() {
    return {
      script: script.value,
      label: label.value,
      enabled: enabled.checked,
      interact: interact.checked,
      stepOn: stepOn.checked,
      stepCooldown: num(cooldown, 1),
      repeat: repeat.checked,
      repeatInterval: num(interval, 5),
      chain: chain.checked,
    };
  }

  /** @param {Partial<Rune>} r */
  function setFields(r) {
    script.value = r.script ?? '';
    label.value = r.label ?? '';
    enabled.checked = r.enabled !== false;
    interact.checked = r.interact !== false;
    stepOn.checked = r.stepOn === true;
    cooldown.value = String(r.stepCooldown ?? 1);
    repeat.checked = r.repeat === true;
    interval.value = String(r.repeatInterval ?? 5);
    chain.checked = r.chain === true;
    refreshDerived();
  }

  /** Line/char counter and live parse errors. */
  function refreshDerived() {
    const text = script.value;
    const lines = text === '' ? 0 : text.split('\n').length;
    el.counter.textContent = `${lines} / ${MAX_RUNE_SCRIPT_LINES} lines · ${text.length} / ${MAX_RUNE_SCRIPT_CHARS} chars`;
    const { errors } = parseScript(text);
    el.errors.textContent = errors.map((e) => `line ${e.line}: ${e.message}`).join('\n');
    el.errors.classList.toggle('hidden', errors.length === 0);
    cooldown.disabled = !stepOn.checked;
    interval.disabled = !repeat.checked;
  }

  function flush() {
    if (debounce !== null) {
      win.clearTimeout(debounce);
      debounce = null;
    }
    if (key !== null) fire('onChange', key, getFields());
  }

  function scheduleChange() {
    if (debounce !== null) win.clearTimeout(debounce);
    debounce = win.setTimeout(() => {
      debounce = null;
      flush();
    }, EDITOR_DEBOUNCE_MS);
  }

  /** @param {RunRecord|null|undefined} rec */
  function showLastRun(rec) {
    if (!rec) {
      el.lastRun.textContent = 'never run';
      return;
    }
    const how = rec.cancelled ? 'cancelled' : 'finished';
    el.lastRun.textContent = `last run (${rec.source}): ${how} after ${rec.commands} command${rec.commands === 1 ? '' : 's'}, ${rec.errors} error${rec.errors === 1 ? '' : 's'}`;
  }

  on(script, 'input', () => {
    // The store keeps at most MAX_RUNE_SCRIPT_LINES lines; trim here so nothing typed is silently lost later.
    const lines = script.value.split('\n');
    if (lines.length > MAX_RUNE_SCRIPT_LINES) {
      const pos = script.selectionStart;
      script.value = lines.slice(0, MAX_RUNE_SCRIPT_LINES).join('\n');
      try {
        const p = Math.min(pos, script.value.length);
        script.setSelectionRange(p, p);
      } catch {
        /* ignore */
      }
    }
    refreshDerived();
    scheduleChange();
  });
  on(label, 'input', scheduleChange);
  for (const box of [enabled, interact, stepOn, repeat, chain]) {
    on(box, 'change', () => {
      refreshDerived();
      flush();
    });
  }
  on(cooldown, 'change', flush);
  on(interval, 'change', flush);
  on(el.run, 'click', () => {
    if (key === null) return;
    flush();
    fire('onRun', key);
  });
  on(el.done, 'click', () => {
    if (key === null) return;
    flush();
    fire('onClose', key);
  });
  on(el.revert, 'click', () => {
    if (key === null || !original) return;
    setFields(original);
    flush();
  });

  /** @param {KeyboardEvent} e */
  function onKeyDown(e) {
    if (!open) return;
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      if (key !== null) {
        flush();
        fire('onClose', key);
      }
      return;
    }
    // Keys typed into the editor must never reach the game's listeners (they are disabled anyway, but be explicit).
    e.stopPropagation();
  }
  doc.addEventListener('keydown', onKeyDown, true);

  /** @param {Rune} rune @param {RunRecord|null} [lastRun] */
  function openEditor(rune, lastRun = null) {
    if (disposed || !rune) return;
    key = rune.key;
    original = {
      script: rune.script, label: rune.label, enabled: rune.enabled, interact: rune.interact, stepOn: rune.stepOn,
      stepCooldown: rune.stepCooldown, repeat: rune.repeat, repeatInterval: rune.repeatInterval, chain: rune.chain,
    };
    el.cell.textContent = `cell ${rune.q} ${rune.y} ${rune.r}`;
    setFields(original);
    showLastRun(lastRun);
    open = true;
    el.layer.classList.remove('hidden');
    win.setTimeout(() => {
      if (!open) return;
      try {
        script.focus();
      } catch {
        /* ignore */
      }
    }, 0);
  }

  function close() {
    if (!open) return;
    flush();
    open = false;
    el.layer.classList.add('hidden');
    if (doc.activeElement && typeof (/** @type {*} */ (doc.activeElement)).blur === 'function') {
      /** @type {*} */ (doc.activeElement).blur();
    }
    key = null;
    original = null;
  }

  return {
    open: openEditor,
    close,
    isOpen: () => open,
    getKey: () => key,
    getFields,
    dispose() {
      if (disposed) return;
      disposed = true;
      close();
      doc.removeEventListener('keydown', onKeyDown, true);
      for (const [t, type, fn] of listeners) t.removeEventListener(type, fn);
      listeners.length = 0;
    },
  };
}
