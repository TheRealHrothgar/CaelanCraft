// Caelancraft — pointer-lock mouse look plus keyboard / mouse input state.
// See src/CONTRACTS.md §18 and docs/SPEC-gameplay.md §4.
//
// DOM module. It only touches the `canvas` and `doc` it is handed (and
// `doc.defaultView` for the window `blur` event); nothing is accessed at module
// top level, so it loads in Node and can be driven with any EventTarget-like
// fakes in tests.
//
// Input policy (from the spec): game input is recorded only while the pointer
// is locked to the canvas AND the controls are enabled. Held keys, queued key
// edges, mouse buttons and double-tap timers are all cleared whenever the lock
// changes, the window blurs, or the controls are disabled, so no stale input
// can fire when play resumes. Ctrl is never bound (Ctrl+W closes the tab) and
// browser defaults are left alone while Ctrl/Meta/Alt is held.
import { MOUSE_SENSITIVITY, PITCH_LIMIT, DOUBLE_TAP_MS, DOUBLE_TAP_SPACE_MS } from './config.js';

/** @typedef {import('./types.js').PlayerInput} PlayerInput */

/**
 * @typedef {Object} MouseState
 * @property {boolean} left           button 0 held
 * @property {boolean} right          button 2 held
 * @property {boolean} middle         button 1 held
 * @property {boolean} leftPressed    button 0 went down since the last consumeMouse()
 * @property {boolean} rightPressed
 * @property {boolean} middlePressed
 * @property {number}  wheel          integer notches since the last consumeMouse(); +1 = scrolled down
 */

/**
 * @typedef {Object} Controls
 * @property {number} yaw                       radians; yaw 0 faces -Z, positive turns left. Mutable.
 * @property {number} pitch                     radians; positive looks up; clamped to ±PITCH_LIMIT on every write.
 * @property {boolean} locked                   doc.pointerLockElement === canvas (live)
 * @property {boolean} enabled                  see setEnabled()
 * @property {() => void} lock                  requestPointerLock; errors / rejections swallowed
 * @property {() => void} unlock                exitPointerLock (only when we hold the lock); errors swallowed
 * @property {(code: string) => boolean} isDown             KeyboardEvent.code currently held
 * @property {(code: string) => boolean} consumePressed     true once per keydown edge (edges are queued)
 * @property {() => MouseState} consumeMouse                edges + wheel reset on return. The returned object is REUSED.
 * @property {() => boolean} consumeFlyToggle               one-shot: Space double-tapped or KeyF pressed
 * @property {() => boolean} isSprinting                    W double-tapped within DOUBLE_TAP_MS and still held
 * @property {() => PlayerInput} getInput                   the returned object is REUSED between calls
 * @property {(locked: boolean) => void} onLockChange       assignable hook, fired when the lock state changes
 * @property {(on: boolean) => void} setEnabled             false: ignore game input and clear state (menus open)
 * @property {() => void} dispose                           removes every listener and clears state
 */

/** Keys whose browser default is suppressed while the pointer is locked (no Ctrl/Meta/Alt). */
export const GAME_KEYS = new Set([
  'Space', 'Tab', 'F3',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9',
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'ShiftLeft', 'ShiftRight',
  'KeyE', 'KeyF', 'KeyM',
]);

/** Upper bound on queued keydown edges per code; protects against unbounded growth for keys nobody consumes. */
export const MAX_QUEUED_EDGES = 8;

const TWO_PI = Math.PI * 2;

/** Clamp pitch to ±PITCH_LIMIT; non-finite input becomes 0. */
export function clampPitch(v) {
  if (!Number.isFinite(v)) return 0;
  if (v > PITCH_LIMIT) return PITCH_LIMIT;
  if (v < -PITCH_LIMIT) return -PITCH_LIMIT;
  return v;
}

/** Wrap yaw into [-π, π] without touching values already in range. */
export function wrapYaw(v) {
  if (!Number.isFinite(v)) return 0;
  if (v > Math.PI) return v - TWO_PI * Math.ceil((v - Math.PI) / TWO_PI);
  if (v < -Math.PI) return v + TWO_PI * Math.ceil((-Math.PI - v) / TWO_PI);
  return v;
}

/** Millisecond clock used only when an event carries no usable timeStamp. */
function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  return Date.now();
}

/** Time of an event in ms; real events carry a DOMHighResTimeStamp, fakes may not. */
function eventTime(e) {
  const t = e.timeStamp;
  return typeof t === 'number' && Number.isFinite(t) ? t : nowMs();
}

/**
 * Create the input controller for the game canvas.
 * @param {HTMLCanvasElement|EventTarget} canvas   pointer-lock target; receives mouse button / wheel / contextmenu events
 * @param {Document|EventTarget} [doc=document]   receives mousemove / keydown / keyup / pointerlockchange
 * @returns {Controls}
 */
export function createControls(canvas, doc = document) {
  if (!canvas || typeof canvas.addEventListener !== 'function') {
    throw new TypeError('createControls: canvas must be an EventTarget');
  }
  if (!doc || typeof doc.addEventListener !== 'function') {
    throw new TypeError('createControls: doc must be a Document-like EventTarget');
  }
  /** @type {(EventTarget & { addEventListener: Function, removeEventListener: Function })|null} */
  const win = doc.defaultView && typeof doc.defaultView.addEventListener === 'function' ? doc.defaultView : null;

  // ---- state -------------------------------------------------------------
  let yaw = 0;
  let pitch = 0;
  let enabled = true;
  let disposed = false;

  /** @type {Set<string>} held key codes */
  const held = new Set();
  /** @type {Map<string, number>} code → queued keydown edges not yet consumed */
  const pressed = new Map();

  let left = false;
  let right = false;
  let middle = false;
  let leftPressed = false;
  let rightPressed = false;
  let middlePressed = false;
  let wheel = 0;

  let lastWDown = -Infinity;
  let lastSpaceDown = -Infinity;
  let sprintArmed = false;
  let flyToggle = false;

  /** @type {MouseState} reused result of consumeMouse() (hot path: no per-frame allocation) */
  const mouseOut = { left: false, right: false, middle: false, leftPressed: false, rightPressed: false, middlePressed: false, wheel: 0 };
  /** @type {PlayerInput} reused result of getInput() */
  const inputOut = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw: 0 };

  function isLocked() {
    return doc.pointerLockElement === canvas;
  }
  let wasLocked = isLocked();

  /** Drop every piece of transient input state (keys, edges, buttons, wheel, tap timers). */
  function clearState() {
    held.clear();
    pressed.clear();
    left = right = middle = false;
    leftPressed = rightPressed = middlePressed = false;
    wheel = 0;
    lastWDown = -Infinity;
    lastSpaceDown = -Infinity;
    sprintArmed = false;
    flyToggle = false;
  }

  // ---- handlers ----------------------------------------------------------
  function onMouseMove(e) {
    if (!enabled || !isLocked()) return;
    const mx = e.movementX;
    const my = e.movementY;
    if (Number.isFinite(mx) && mx !== 0) yaw = wrapYaw(yaw - mx * MOUSE_SENSITIVITY);
    if (Number.isFinite(my) && my !== 0) pitch = clampPitch(pitch - my * MOUSE_SENSITIVITY);
  }

  function onKeyDown(e) {
    const code = e.code;
    if (typeof code !== 'string' || code === '') return;
    if (!isLocked()) return;
    if (GAME_KEYS.has(code) && !e.ctrlKey && !e.metaKey && !e.altKey && typeof e.preventDefault === 'function') {
      e.preventDefault();
    }
    if (!enabled) return;
    // Auto-repeat keydowns still (re)mark the key as held so a key that was
    // physically down before the lock was acquired heals itself.
    held.add(code);
    if (e.repeat) return;

    const n = pressed.get(code) || 0;
    if (n < MAX_QUEUED_EDGES) pressed.set(code, n + 1);

    if (code === 'KeyW') {
      const t = eventTime(e);
      if (t - lastWDown <= DOUBLE_TAP_MS) sprintArmed = true;
      lastWDown = t;
    } else if (code === 'Space') {
      const t = eventTime(e);
      if (t - lastSpaceDown <= DOUBLE_TAP_SPACE_MS) {
        flyToggle = true;
        lastSpaceDown = -Infinity; // each toggle consumes both taps
      } else {
        lastSpaceDown = t;
      }
    } else if (code === 'KeyF') {
      flyToggle = true;
    }
  }

  function onKeyUp(e) {
    const code = e.code;
    if (typeof code !== 'string' || code === '') return;
    // Releases are always honoured (even when disabled/unlocked) so keys can never stick.
    held.delete(code);
    if (code === 'KeyW') sprintArmed = false;
  }

  function onPointerLockChange() {
    const now = isLocked();
    if (now === wasLocked) return;
    wasLocked = now;
    clearState();
    if (typeof api.onLockChange === 'function') api.onLockChange(now);
  }

  function onBlur() {
    clearState();
  }

  function onMouseDown(e) {
    const b = e.button;
    // Middle click: stop autoscroll / primary-selection paste regardless of lock state.
    if (b === 1 && typeof e.preventDefault === 'function') e.preventDefault();
    if (!enabled || !isLocked()) return;
    if (b === 0) {
      left = true;
      leftPressed = true;
    } else if (b === 2) {
      right = true;
      rightPressed = true;
    } else if (b === 1) {
      middle = true;
      middlePressed = true;
    }
  }

  function onMouseUp(e) {
    const b = e.button;
    if (b === 0) left = false;
    else if (b === 2) right = false;
    else if (b === 1) middle = false;
  }

  function onWheel(e) {
    if (!enabled || !isLocked()) return;
    const d = e.deltaY;
    if (d > 0) wheel += 1;
    else if (d < 0) wheel -= 1;
  }

  function onContextMenu(e) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
  }

  // ---- public API --------------------------------------------------------
  function lock() {
    try {
      if (isLocked()) return;
      const p = typeof canvas.requestPointerLock === 'function' ? canvas.requestPointerLock() : undefined;
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      // Pointer lock unavailable (no user gesture, unsupported, cooldown) — nothing to do.
    }
  }

  function unlock() {
    try {
      if (isLocked() && typeof doc.exitPointerLock === 'function') doc.exitPointerLock();
    } catch {
      // ignore
    }
  }

  function isDown(code) {
    return held.has(code);
  }

  function consumePressed(code) {
    const n = pressed.get(code);
    if (!n) return false;
    if (n === 1) pressed.delete(code);
    else pressed.set(code, n - 1);
    return true;
  }

  function consumeMouse() {
    mouseOut.left = left;
    mouseOut.right = right;
    mouseOut.middle = middle;
    mouseOut.leftPressed = leftPressed;
    mouseOut.rightPressed = rightPressed;
    mouseOut.middlePressed = middlePressed;
    mouseOut.wheel = wheel;
    leftPressed = rightPressed = middlePressed = false;
    wheel = 0;
    return mouseOut;
  }

  function consumeFlyToggle() {
    const v = flyToggle;
    flyToggle = false;
    return v;
  }

  function isSprinting() {
    return sprintArmed && held.has('KeyW');
  }

  function getInput() {
    inputOut.forward =
      (held.has('KeyW') || held.has('ArrowUp') ? 1 : 0) - (held.has('KeyS') || held.has('ArrowDown') ? 1 : 0);
    inputOut.strafe =
      (held.has('KeyD') || held.has('ArrowRight') ? 1 : 0) - (held.has('KeyA') || held.has('ArrowLeft') ? 1 : 0);
    inputOut.jump = held.has('Space');
    inputOut.sneak = held.has('ShiftLeft') || held.has('ShiftRight');
    inputOut.sprint = sprintArmed && held.has('KeyW');
    inputOut.yaw = yaw;
    return inputOut;
  }

  function setEnabled(on) {
    enabled = !!on;
    if (!enabled) clearState();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    doc.removeEventListener('mousemove', onMouseMove);
    doc.removeEventListener('keydown', onKeyDown);
    doc.removeEventListener('keyup', onKeyUp);
    doc.removeEventListener('pointerlockchange', onPointerLockChange);
    canvas.removeEventListener('mousedown', onMouseDown);
    canvas.removeEventListener('mouseup', onMouseUp);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('contextmenu', onContextMenu);
    if (win) win.removeEventListener('blur', onBlur);
    clearState();
  }

  /** @type {Controls} */
  const api = {
    get yaw() {
      return yaw;
    },
    set yaw(v) {
      yaw = Number.isFinite(v) ? v : 0;
    },
    get pitch() {
      return pitch;
    },
    set pitch(v) {
      pitch = clampPitch(v);
    },
    get locked() {
      return isLocked();
    },
    get enabled() {
      return enabled;
    },
    lock,
    unlock,
    isDown,
    consumePressed,
    consumeMouse,
    consumeFlyToggle,
    isSprinting,
    getInput,
    onLockChange: (_locked) => {},
    setEnabled,
    dispose,
  };

  // ---- wiring ------------------------------------------------------------
  doc.addEventListener('mousemove', onMouseMove);
  doc.addEventListener('keydown', onKeyDown);
  doc.addEventListener('keyup', onKeyUp);
  doc.addEventListener('pointerlockchange', onPointerLockChange);
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('wheel', onWheel, { passive: true });
  canvas.addEventListener('contextmenu', onContextMenu);
  if (win) win.addEventListener('blur', onBlur);

  return api;
}
