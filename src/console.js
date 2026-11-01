// Caelancraft — the command console: a scrollback log and one input line. See src/CONTRACTS.md §28.
//
// DOM module. Opened by main in the `console` state (controls disabled, pointer unlocked, simulation frozen).
// The console only owns its own elements; executing a line is main's job via the `onLine` callback (which runs
// the same executor as rune scripts). History lives in memory only.
import { MAX_CONSOLE_LINES, CONSOLE_HISTORY } from './config.js';

/** Element ids in index.html this module binds to. */
const IDS = Object.freeze({ layer: 'console', log: 'console-log', input: 'console-input' });

/**
 * @typedef {Object} ConsoleCallbacks
 * @property {(line: string) => ({ ok: boolean, message: string }|void)} [onLine]   execute one typed line; the result is echoed
 * @property {() => void} [onClose]                                                  Esc / Enter on an empty line
 */

/**
 * @typedef {Object} Console
 * @property {(prefill?: string) => void} open     show, focus the input (on the next tick, so the key that opened it is not typed) and prefill it
 * @property {() => void} close
 * @property {() => boolean} isOpen
 * @property {(text: string, isError?: boolean) => void} log   append line(s) to the scrollback (multi-line text is split)
 * @property {() => void} clear
 * @property {() => void} dispose
 */

/**
 * @param {Document} doc
 * @param {ConsoleCallbacks} [callbacks]
 * @returns {Console}
 */
export function createConsole(doc, callbacks = {}) {
  const layer = doc.getElementById(IDS.layer);
  const logEl = doc.getElementById(IDS.log);
  const input = /** @type {HTMLInputElement|null} */ (doc.getElementById(IDS.input));
  if (!layer || !logEl || !input) throw new Error('console: missing #console, #console-log or #console-input');
  const win = doc.defaultView || globalThis;

  let open = false;
  let disposed = false;
  /** @type {string[]} */
  const history = [];
  let historyIndex = -1;
  let draft = '';
  /** @type {number|null} */
  let focusTimer = null;

  function fire(name, ...args) {
    const fn = callbacks ? callbacks[name] : undefined;
    return typeof fn === 'function' ? fn(...args) : undefined;
  }

  /** @param {string} text @param {boolean} [isError] */
  function log(text, isError = false) {
    const lines = String(text ?? '').split('\n');
    for (const line of lines) {
      const div = doc.createElement('div');
      div.textContent = line;
      if (isError) div.className = 'err';
      logEl.appendChild(div);
    }
    while (logEl.childNodes.length > MAX_CONSOLE_LINES && logEl.firstChild) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function clear() {
    while (logEl.firstChild) logEl.removeChild(logEl.firstChild);
  }

  function submit() {
    const line = input.value.trim();
    if (line === '') {
      fire('onClose');
      return;
    }
    if (history[history.length - 1] !== line) {
      history.push(line);
      while (history.length > CONSOLE_HISTORY) history.shift();
    }
    historyIndex = -1;
    draft = '';
    log(`> ${line}`);
    const res = fire('onLine', line);
    if (res && typeof res === 'object' && res.message) log(res.message, res.ok === false);
    input.value = '';
  }

  /** @param {number} dir  -1 = older, +1 = newer */
  function navigate(dir) {
    if (history.length === 0) return;
    if (historyIndex === -1) {
      if (dir > 0) return;
      draft = input.value;
      historyIndex = history.length - 1;
    } else {
      historyIndex += dir;
      if (historyIndex >= history.length) {
        historyIndex = -1;
        input.value = draft;
        return;
      }
      if (historyIndex < 0) historyIndex = 0;
    }
    input.value = history[historyIndex];
    try {
      input.setSelectionRange(input.value.length, input.value.length);
    } catch {
      /* not every input implementation supports it */
    }
  }

  /** @param {KeyboardEvent} e */
  function onKeyDown(e) {
    if (!open) return;
    const key = e.key || e.code;
    if (key === 'Enter' || key === 'NumpadEnter') {
      e.preventDefault();
      submit();
    } else if (key === 'Escape' || key === 'Esc') {
      e.preventDefault();
      fire('onClose');
    } else if (key === 'ArrowUp') {
      e.preventDefault();
      navigate(-1);
    } else if (key === 'ArrowDown') {
      e.preventDefault();
      navigate(1);
    }
    // Never let a key that reaches the input bubble to the game's listeners.
    e.stopPropagation();
  }

  /**
   * Fallback for when the input lost focus (a click on the scrollback to copy text, or on the canvas): the hint
   * promises Esc closes, and Enter should keep working. Only acts when the input is not the event target (the
   * input's own handler stops propagation).
   * @param {KeyboardEvent} e
   */
  function onDocKeyDown(e) {
    if (!open || e.target === input) return;
    const key = e.key || e.code;
    if (key === 'Escape' || key === 'Esc') {
      e.preventDefault();
      fire('onClose');
    } else if (key === 'Enter' || key === 'NumpadEnter') {
      e.preventDefault();
      submit();
    } else if (typeof key === 'string' && key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      try {
        input.focus(); // bring typing back to the line
      } catch {
        /* ignore */
      }
    }
  }

  function openConsole(prefill = '') {
    if (disposed) return;
    open = true;
    layer.classList.remove('hidden');
    historyIndex = -1;
    draft = '';
    input.value = '';
    // The keydown that opened the console is followed by a keypress/input in the same task; focusing and
    // prefilling on the next tick keeps that character out of the line.
    if (focusTimer !== null) win.clearTimeout(focusTimer);
    focusTimer = win.setTimeout(() => {
      focusTimer = null;
      if (!open) return;
      input.value = prefill;
      try {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      } catch {
        /* ignore */
      }
    }, 0);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function close() {
    if (!open) return;
    open = false;
    if (focusTimer !== null) {
      win.clearTimeout(focusTimer);
      focusTimer = null;
    }
    layer.classList.add('hidden');
    if (doc.activeElement === input && typeof input.blur === 'function') input.blur();
  }

  input.addEventListener('keydown', onKeyDown);
  doc.addEventListener('keydown', onDocKeyDown, true);

  return {
    open: openConsole,
    close,
    isOpen: () => open,
    log,
    clear,
    dispose() {
      if (disposed) return;
      disposed = true;
      close();
      input.removeEventListener('keydown', onKeyDown);
      doc.removeEventListener('keydown', onDocKeyDown, true);
    },
  };
}
