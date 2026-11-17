// Caelancraft — touch controls for the iPad (docs/DESIGN-multiplayer.md §5, src/CONTRACTS.md §95).
//
// Two halves. The PURE half (no DOM; loads and runs under Node): touch-mode detection, the stick and look maths, the button
// table and TouchPad, which turns abstract pointers and button presses into calls on a Controls-like sink — controls.js's
// virtual* API, so main reads touch exactly as it reads the keyboard and the mouse. The DOM half, createTouchUI(doc,
// controls, hooks), builds the on-screen controls (only in touch mode), feeds Pointer Events to a TouchPad and draws the
// stick and the pressed buttons. Nothing is touched at module top level.
//
// Multi-touch: every pointer is tracked by its pointerId, so a thumb on the stick, a finger dragging the look and a finger
// holding Dig all work at once. Scrolling, zooming and long-press callouts are off on the game (touch-action: none).

import { HOTBAR_SIZE } from './config.js';

/** View distance (chunks) a touch device starts with; `?rd=` still wins (§95). */
export const TOUCH_RENDER_DISTANCE = 4;
/** Radians the view turns per CSS pixel dragged (a 590-px half-screen drag turns about 170°). */
export const TOUCH_LOOK_SENSITIVITY = 0.005;
/** Pixels from the stick's centre to its rim: how far the knob travels. */
export const STICK_RADIUS = 60;
/** Fraction of the radius round the centre that moves nothing (a resting thumb). */
export const STICK_DEAD = 0.12;
/** Fraction of the radius from which a forward push sprints (the rim). */
export const STICK_SPRINT = 0.9;
/** A sprinting push points within about 45° of straight ahead (the forward share of the direction is at least this). */
export const STICK_SPRINT_COS = 0.7;
/** A touch landing left of this fraction of the screen width takes the stick; elsewhere it drags the look. */
export const STICK_ZONE = 0.5;
/** A tap that began on a touch button never also clicks what is under the finger when it lifts (a menu it opened). */
export const CLICK_SWALLOW_MS = 400;

/**
 * The on-screen buttons. kind: 'jump' (held: setVirtualJump), 'mouse' (held: a mouse button), 'key' (held: a key; its
 * press is one keydown edge), 'sneak' (a toggle on the ground; held while flying, to go down), 'hook' (calls main).
 * @type {Readonly<Record<string, Readonly<{ label: string, kind: 'jump'|'mouse'|'key'|'sneak'|'hook', button?: number, code?: string, hook?: string }>>>}
 */
export const TOUCH_BUTTONS = Object.freeze({
  jump: Object.freeze({ label: 'Jump', kind: 'jump' }), // held; a double tap toggles flight in Creative, as Space (§97.5)
  dig: Object.freeze({ label: 'Mine', kind: 'mouse', button: 0 }), // hold: break, dig, strike (left mouse held)
  place: Object.freeze({ label: 'Place', kind: 'mouse', button: 2 }), // tap: place / use; hold: keep using (right mouse)
  act: Object.freeze({ label: 'Action', kind: 'key', code: 'KeyR' }), // the R key (drink, open, feed, …); hold repeats
  sneak: Object.freeze({ label: 'Crouch', kind: 'sneak', code: 'ShiftLeft' }), // also the Shift of Shift+R, Shift+Q
  drop: Object.freeze({ label: 'Drop', kind: 'key', code: 'KeyQ' }),
  pause: Object.freeze({ label: 'Menu', kind: 'hook', hook: 'onPause' }),
  pack: Object.freeze({ label: 'Pack', kind: 'key', code: 'KeyE' }), // Creative: the block picker ("Blocks")
  view: Object.freeze({ label: 'Camera', kind: 'key', code: 'KeyV' }),
  chat: Object.freeze({ label: 'Chat', kind: 'key', code: 'KeyT' }),
  // §103: look through the Spyglass and keep looking (a toggle, like the zoom command); shown only while one is carried
  zoom: Object.freeze({ label: 'Zoom', kind: 'hook', hook: 'onZoom' }),
});
/**
 * Key names in a hint written for the keyboard, and the touch buttons that do the same (§97.2): the R key is Action, Shift
 * is Crouch, the left mouse button Mine, the right one Place. A clause for the G key (§60's throw at once) is left out:
 * there is no button for it. Applied in order (Shift+R before R).
 * @type {ReadonlyArray<readonly [RegExp, string]>}
 */
const TOUCH_WORDS = Object.freeze([
  [/ · G: [^·]*?(?=( · |$))/g, ''],
  [/\bShift\+R(?: key)?\b/g, 'Crouch + Action'],
  [/\bShift\+right-click\b/gi, 'Crouch + Place'],
  [/\bR key\b/g, 'Action button'],
  [/\bR\b/g, 'Action'],
  [/\bLMB\b/g, 'Mine'],
  [/\bRMB or Z\b/g, 'Place, or tap Zoom,'], // §103: the Spyglass's hint (no Z key on a tablet)
  [/\bRMB\b/g, 'Place'],
  [/\bright-click\b/gi, 'Place'],
]);

/**
 * A hint in the touch buttons' words: "Birch Log · R: tap sap" → "Birch Log · Action: tap sap". PURE.
 * @param {string} text @returns {string}
 */
export function touchWords(text) {
  let s = String(text);
  for (const [re, word] of TOUCH_WORDS) s = s.replace(re, word);
  return s;
}

/** The right-hand cluster, and the bar at the top left, in DOM order. */
export const PAD_BUTTONS = Object.freeze(['jump', 'dig', 'place', 'act', 'sneak', 'drop']);
export const TOP_BUTTONS = Object.freeze(['pause', 'pack', 'view', 'chat', 'zoom']);

/**
 * Is top-bar button `id` shown for `view`? Every one is, but the Zoom button (§103) only while a Spyglass is carried
 * (`view.zoom`). PURE. @param {string} id @param {TouchView|null|undefined} view @returns {boolean}
 */
export function topButtonShown(id, view) {
  if (id === 'zoom') return !!(view && view.zoom);
  return TOP_BUTTONS.includes(id);
}

/**
 * Where the right cluster's buttons lie (CSS px, as styles.css places `.touch-pad` and its buttons): `right` and `bottom`
 * (in portrait `bottomPortrait`) are the pad's from the window's edges; `width` from its right edge to the leftmost
 * button's left edge (Drop's), `height` from its bottom to the highest button's top (Place's).
 */
export const TOUCH_CLUSTER = Object.freeze({ right: 14, bottom: 92, bottomPortrait: 104, width: 276, height: 190 });

/**
 * The box the right cluster's buttons cover in a window `width` × `height` (CSS px, y down; safe-area insets aside).
 * PURE. @param {number} width @param {number} height
 * @returns {{ left: number, top: number, right: number, bottom: number }}
 */
export function touchClusterRect(width, height) {
  const C = TOUCH_CLUSTER;
  const bottom = height - (height >= width ? C.bottomPortrait : C.bottom); // CSS (orientation: portrait): height ≥ width
  const right = width - C.right;
  return { left: right - C.width, top: bottom - C.height, right, bottom };
}

// ---------------------------------------------------------------------------------------------
// Touch-mode detection (PURE)
// ---------------------------------------------------------------------------------------------

/**
 * `?touch=` → true (`1`, `true`, `on`, `yes` or bare `?touch`), false (`0`, `false`, `off`, `no`), else null (absent or
 * anything else: detect).
 * @param {string|URLSearchParams|null|undefined} search
 * @returns {boolean|null}
 */
export function readTouchParam(search) {
  let v;
  try {
    v = (search instanceof URLSearchParams ? search : new URLSearchParams(search ?? '')).get('touch');
  } catch {
    return null;
  }
  if (v === null) return null;
  const t = v.trim().toLowerCase();
  if (t === '' || t === '1' || t === 'true' || t === 'on' || t === 'yes') return true;
  if (t === '0' || t === 'false' || t === 'off' || t === 'no') return false;
  return null;
}

/**
 * Touch mode from what the page knows: `?touch=` wins; else a coarse primary pointer (a tablet or a phone), or several
 * touch points with no fine pointer anywhere (iPadOS Safari calls itself a Mac but has touch points and no mouse). A PC with
 * a touch screen and a mouse or trackpad stays a desktop.
 * @param {{ param?: boolean|null, coarse?: boolean, fine?: boolean, maxTouchPoints?: number }} env
 * @returns {boolean}
 */
export function touchModeFor(env) {
  if (env.param === true || env.param === false) return env.param;
  if (env.coarse) return true;
  return (Number(env.maxTouchPoints) || 0) > 1 && !env.fine;
}

/**
 * Touch mode for this window: `?touch=`, `matchMedia('(pointer: coarse)')`, `matchMedia('(any-pointer: fine)')` and
 * `navigator.maxTouchPoints`. Anything missing or throwing counts as absent.
 * @param {any} win
 * @returns {boolean}
 */
export function detectTouchMode(win) {
  if (!win) return false;
  const mq = (/** @type {string} */ q) => {
    try {
      return typeof win.matchMedia === 'function' && !!win.matchMedia(q).matches;
    } catch {
      return false;
    }
  };
  let search;
  try {
    search = win.location ? String(win.location.search ?? '') : '';
  } catch {
    search = '';
  }
  return touchModeFor({
    param: readTouchParam(search),
    coarse: mq('(pointer: coarse)'),
    fine: mq('(any-pointer: fine)'),
    maxTouchPoints: win.navigator ? Number(win.navigator.maxTouchPoints) || 0 : 0,
  });
}

// ---------------------------------------------------------------------------------------------
// The stick and the look (PURE)
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {Object} StickVector
 * @property {number} forward  -1..1 (+1 = the thumb pushed up the screen)
 * @property {number} strafe   -1..1 (+1 = right)
 * @property {boolean} sprint  pushed to the rim, within about 45° of straight ahead
 * @property {number} knobX    the knob's offset from the centre, clamped to the radius (px)
 * @property {number} knobY
 */

/**
 * The stick for a thumb (dx, dy) px from where it landed (screen y grows downwards). Inside the dead zone nothing moves;
 * beyond it the push grows linearly to full at the rim; at the rim, pointing ahead, it sprints at full speed.
 * @param {number} dx
 * @param {number} dy
 * @param {number} [radius]
 * @param {StickVector} [out]  reused when given
 * @returns {StickVector}
 */
export function stickVector(dx, dy, radius = STICK_RADIUS, out = { forward: 0, strafe: 0, sprint: false, knobX: 0, knobY: 0 }) {
  const x = Number.isFinite(dx) ? dx : 0;
  const y = Number.isFinite(dy) ? dy : 0;
  const r = radius > 0 ? radius : STICK_RADIUS;
  const d = Math.hypot(x, y);
  const k = d > r ? r / d : 1;
  out.knobX = x * k;
  out.knobY = y * k;
  const dead = r * STICK_DEAD;
  if (!(d > dead)) {
    out.forward = 0;
    out.strafe = 0;
    out.sprint = false;
    return out;
  }
  const ux = x / d;
  const uy = -y / d; // up the screen = forward
  out.sprint = d >= r * STICK_SPRINT && uy >= STICK_SPRINT_COS;
  const m = out.sprint ? 1 : Math.min(1, (d - dead) / (r - dead));
  out.forward = uy * m;
  out.strafe = ux * m;
  return out;
}

/**
 * Look deltas for a drag of (dx, dy) px: dragging right turns right, dragging up looks up (as the mouse does).
 * @param {number} dx
 * @param {number} dy
 * @param {number} [sensitivity]  radians per px
 * @returns {[number, number]} [dYaw, dPitch] (positive yaw turns left, positive pitch looks up)
 */
export function lookDelta(dx, dy, sensitivity = TOUCH_LOOK_SENSITIVITY) {
  const x = Number.isFinite(dx) ? dx : 0;
  const y = Number.isFinite(dy) ? dy : 0;
  return [x === 0 ? 0 : -x * sensitivity, y === 0 ? 0 : -y * sensitivity];
}

/**
 * The key code a tap on hotbar slot `slot` (0-based) stands for, or null.
 * @param {unknown} slot
 * @returns {string|null}
 */
export function hotbarCode(slot) {
  const i = Number(slot);
  return Number.isInteger(i) && i >= 0 && i < HOTBAR_SIZE ? `Digit${i + 1}` : null;
}

// ---------------------------------------------------------------------------------------------
// TouchPad: pointers and buttons → the controls' virtual input (PURE)
// ---------------------------------------------------------------------------------------------

/**
 * What TouchPad drives: controls.js's virtual API (CONTRACTS §95).
 * @typedef {Object} TouchSink
 * @property {(code: string, down: boolean) => void} virtualKey
 * @property {(button: number, down: boolean) => void} virtualButton
 * @property {(dYaw: number, dPitch: number) => void} virtualLook
 * @property {(forward: number, strafe: number, sprint: boolean) => void} setVirtualMove
 * @property {(on: boolean) => void} setVirtualJump
 * @property {(code: string) => boolean} isDown
 */

/**
 * @typedef {Object} TouchHooks
 * @property {() => void} [onPause]   the Pause button
 * @property {() => void} [onTouch]   any touch on the controls (main wakes a sleeper with it)
 * @property {() => void} [onZoom]    the Zoom button (§103: main looks through the Spyglass, or stops)
 */

export class TouchPad {
  /**
   * @param {TouchSink} sink
   * @param {TouchHooks} [hooks]
   * @param {{ lookSensitivity?: number, stickRadius?: number }} [opts]
   */
  constructor(sink, hooks = {}, opts = {}) {
    this.sink = sink;
    this.hooks = hooks;
    this.lookSensitivity = opts.lookSensitivity ?? TOUCH_LOOK_SENSITIVITY;
    this.stickRadius = opts.stickRadius ?? STICK_RADIUS;
    /** @type {Map<number, { kind: 'stick'|'look'|'button', id: string|null, x: number, y: number }>} pointerId → its job */
    this.pointers = new Map();
    /** The stick: the pointer on it (null: none), where it landed, and its vector. */
    this.stick = { id: /** @type {number|null} */ (null), baseX: 0, baseY: 0, ...stickVector(0, 0) };
    /** @type {number|null} the pointer dragging the look */
    this.lookId = null;
    /** @type {Map<string, number>} button id → the pointer holding it */
    this.held = new Map();
    /** Sneak latched on (on the ground the Sneak button is a toggle). */
    this.sneakOn = false;
    /** The player flies (main says, every frame): Sneak is then held to go down. */
    this.flying = false;
  }

  /**
   * A pointer lands at (x, y): on button `buttonId`, or in the open (null), where left of `zoneX` it takes the stick (if
   * free) and elsewhere the look (if free).
   * @param {number} pid
   * @param {number} x
   * @param {number} y
   * @param {number} zoneX
   * @param {string|null} [buttonId]
   * @returns {'stick'|'look'|'button'|null} what the pointer does (null: nothing, it is ignored)
   */
  down(pid, x, y, zoneX, buttonId = null) {
    if (this.pointers.has(pid)) this.up(pid);
    if (typeof this.hooks.onTouch === 'function') this.hooks.onTouch();
    if (buttonId !== null) {
      if (!Object.hasOwn(TOUCH_BUTTONS, buttonId) || this.held.has(buttonId)) return null;
      this.pointers.set(pid, { kind: 'button', id: buttonId, x, y });
      this.held.set(buttonId, pid);
      this.press(buttonId);
      return 'button';
    }
    if (x < zoneX && this.stick.id === null) {
      this.pointers.set(pid, { kind: 'stick', id: null, x, y });
      const s = this.stick;
      s.id = pid;
      s.baseX = x;
      s.baseY = y;
      stickVector(0, 0, this.stickRadius, s);
      this.sink.setVirtualMove(0, 0, false);
      return 'stick';
    }
    if (this.lookId === null) {
      this.pointers.set(pid, { kind: 'look', id: null, x, y });
      this.lookId = pid;
      return 'look';
    }
    return null;
  }

  /**
   * A tracked pointer moves to (x, y).
   * @param {number} pid
   * @param {number} x
   * @param {number} y
   */
  move(pid, x, y) {
    const p = this.pointers.get(pid);
    if (!p || !Number.isFinite(x) || !Number.isFinite(y)) return;
    if (p.kind === 'stick') {
      const s = this.stick;
      stickVector(x - s.baseX, y - s.baseY, this.stickRadius, s);
      this.sink.setVirtualMove(s.forward, s.strafe, s.sprint);
    } else if (p.kind === 'look') {
      const [dYaw, dPitch] = lookDelta(x - p.x, y - p.y, this.lookSensitivity);
      if (dYaw !== 0 || dPitch !== 0) this.sink.virtualLook(dYaw, dPitch);
    }
    p.x = x;
    p.y = y;
  }

  /**
   * A tracked pointer lifts (or is cancelled).
   * @param {number} pid
   * @returns {'stick'|'look'|'button'|null} what it was doing
   */
  up(pid) {
    const p = this.pointers.get(pid);
    if (!p) return null;
    this.pointers.delete(pid);
    if (p.kind === 'stick') {
      this.stick.id = null;
      stickVector(0, 0, this.stickRadius, this.stick);
      this.sink.setVirtualMove(0, 0, false);
    } else if (p.kind === 'look') {
      this.lookId = null;
    } else if (p.id !== null && this.held.get(p.id) === pid) {
      this.held.delete(p.id);
      this.release(p.id);
    }
    return p.kind;
  }

  /** Let go of everything (the controls hide: a menu, the pack, the pause). The Sneak latch is kept. */
  reset() {
    for (const pid of [...this.pointers.keys()]) this.up(pid);
  }

  /**
   * Once a frame while playing: taking off clears the Sneak latch (Sneak is then held to go down); what a cleared controls
   * state forgot (a lock change, a menu) is asserted again — the latch's Shift, the stick, a held Jump.
   * @param {boolean} flying
   */
  frame(flying) {
    const code = /** @type {string} */ (TOUCH_BUTTONS.sneak.code);
    if (flying && !this.flying && this.sneakOn) {
      this.sneakOn = false;
      if (!this.held.has('sneak')) this.sink.virtualKey(code, false);
    }
    this.flying = !!flying;
    if (this.sneakOn && !this.sink.isDown(code)) this.sink.virtualKey(code, true);
    const s = this.stick;
    this.sink.setVirtualMove(s.forward, s.strafe, s.sprint);
    this.sink.setVirtualJump(this.held.has('jump'));
  }

  /** @param {string} id */
  press(id) {
    const b = TOUCH_BUTTONS[id];
    const sink = this.sink;
    switch (b.kind) {
      case 'jump':
        sink.setVirtualJump(true);
        break;
      case 'mouse':
        sink.virtualButton(/** @type {number} */ (b.button), true);
        break;
      case 'key':
        sink.virtualKey(/** @type {string} */ (b.code), true);
        break;
      case 'sneak':
        if (this.flying) {
          sink.virtualKey(/** @type {string} */ (b.code), true); // held: down
        } else {
          this.sneakOn = !this.sneakOn;
          sink.virtualKey(/** @type {string} */ (b.code), this.sneakOn);
        }
        break;
      case 'hook': {
        const fn = this.hooks[/** @type {keyof TouchHooks} */ (b.hook)];
        if (typeof fn === 'function') fn();
        break;
      }
      default:
        break;
    }
  }

  /** @param {string} id */
  release(id) {
    const b = TOUCH_BUTTONS[id];
    const sink = this.sink;
    switch (b.kind) {
      case 'jump':
        sink.setVirtualJump(false);
        break;
      case 'mouse':
        sink.virtualButton(/** @type {number} */ (b.button), false);
        break;
      case 'key':
        sink.virtualKey(/** @type {string} */ (b.code), false);
        break;
      case 'sneak':
        if (!this.sneakOn) sink.virtualKey(/** @type {string} */ (b.code), false); // the flying hold ends; a latch stays
        break;
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The on-screen controls (DOM)
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {Object} TouchView  what main tells the controls every frame
 * @property {boolean} playing   the game is being played (no menu over it): the controls show and act
 * @property {boolean} [back]    a screen with no close button of its own is open (the block picker, the console)
 * @property {boolean} [survival]
 * @property {boolean} [flying]
 * @property {boolean} [zoom]      a Spyglass is carried: the Zoom button shows (§103)
 * @property {boolean} [zoomOn]    the zoom is kept up: the button is lit (§103)
 */

/**
 * @typedef {Object} TouchUI
 * @property {(view: TouchView) => void} update   once a frame; touches the DOM only when something changed
 * @property {TouchPad} pad
 * @property {() => void} dispose                 removes the controls and every listener
 */

/** Pointy-top hexagon points in a 100 × 100 box (the stick's rim; nothing is drawn on it). */
const STICK_HEX = '50,3 91,26.5 91,73.5 50,97 9,73.5 9,26.5';
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Build the touch controls into `doc.body` and drive `controls` from them (touch mode only; main calls it).
 * @param {Document} doc
 * @param {import('./controls.js').Controls} controls
 * @param {TouchHooks & { onBack?: () => void }} [hooks]  onBack: the Back button (closes the picker or the console)
 * @returns {TouchUI}
 */
export function createTouchUI(doc, controls, hooks = {}) {
  const win = /** @type {any} */ (doc.defaultView);
  const now = () => (win && win.performance && typeof win.performance.now === 'function' ? win.performance.now() : Date.now());
  const pad = new TouchPad(controls, {
    onPause: () => {
      if (typeof hooks.onPause === 'function') hooks.onPause();
    },
    onTouch: () => {
      if (typeof hooks.onTouch === 'function') hooks.onTouch();
    },
    onZoom: () => {
      if (typeof hooks.onZoom === 'function') hooks.onZoom();
    },
  });

  const make = (/** @type {string} */ tag, /** @type {string} */ cls, /** @type {string} */ text = '') => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  };

  doc.documentElement.classList.add('touch');

  const layer = make('div', 'layer touch-ui hidden');
  layer.id = 'touch-ui';
  layer.setAttribute('aria-hidden', 'true');

  const stickEl = make('div', 'touch-stick idle');
  const rim = doc.createElementNS(SVG_NS, 'svg');
  rim.setAttribute('class', 'touch-stick-rim');
  rim.setAttribute('viewBox', '0 0 100 100');
  rim.setAttribute('aria-hidden', 'true');
  const hex = doc.createElementNS(SVG_NS, 'polygon');
  hex.setAttribute('points', STICK_HEX);
  rim.appendChild(hex);
  stickEl.appendChild(rim);
  const knob = make('div', 'touch-knob');
  stickEl.appendChild(knob);
  layer.appendChild(stickEl);

  /** @type {Map<string, HTMLElement>} */
  const buttons = new Map();
  const addButton = (/** @type {HTMLElement} */ parent, /** @type {string} */ id, /** @type {string} */ cls) => {
    const b = make('div', `touch-btn ${cls} tb-${id}`, TOUCH_BUTTONS[id].label);
    b.dataset.touch = id;
    parent.appendChild(b);
    buttons.set(id, b);
  };
  const top = make('div', 'touch-top');
  for (const id of TOP_BUTTONS) addButton(top, id, 'touch-square');
  const cluster = make('div', 'touch-pad');
  for (const id of PAD_BUTTONS) addButton(cluster, id, 'touch-round');
  layer.append(top, cluster);

  const back = /** @type {HTMLButtonElement} */ (make('button', 'touch-btn touch-square touch-back hidden', 'Back'));
  back.type = 'button';
  back.id = 'touch-back';
  back.setAttribute('aria-label', 'Back to the game');

  doc.body.appendChild(layer);
  doc.body.appendChild(back);

  // "Click to play" is a tap here.
  const ctp = doc.querySelector('#click-to-play .ctp-text');
  const ctpText = ctp ? ctp.textContent : null;
  if (ctp) ctp.textContent = 'Tap to play';

  let active = false;
  let swallowUntil = 0;
  /** @type {Set<number>} pointers that pressed a button (their lift arms the click swallow) */
  const buttonPointers = new Set();

  // ---- events ----
  const onDown = (/** @type {PointerEvent} */ e) => {
    if (!active) return;
    if (e.cancelable !== false && typeof e.preventDefault === 'function') e.preventDefault();
    const target = /** @type {HTMLElement|null} */ (e.target);
    const btn = target && typeof target.closest === 'function' ? /** @type {HTMLElement|null} */ (target.closest('[data-touch]')) : null;
    const id = btn && btn.dataset.touch ? btn.dataset.touch : null;
    const width = win && Number.isFinite(win.innerWidth) ? win.innerWidth : 1024;
    const kind = pad.down(e.pointerId, e.clientX, e.clientY, width * STICK_ZONE, id);
    if (!kind) return;
    if (kind === 'button') buttonPointers.add(e.pointerId);
    try {
      if (typeof layer.setPointerCapture === 'function') layer.setPointerCapture(e.pointerId);
    } catch {
      // a pointer that is already gone
    }
    draw();
  };
  const onMove = (/** @type {PointerEvent} */ e) => {
    if (!active || !pad.pointers.has(e.pointerId)) return;
    pad.move(e.pointerId, e.clientX, e.clientY);
    if (pad.stick.id === e.pointerId) drawStick();
  };
  const onUp = (/** @type {PointerEvent} */ e) => {
    if (buttonPointers.delete(e.pointerId)) swallowUntil = now() + CLICK_SWALLOW_MS;
    if (pad.up(e.pointerId) !== null) draw();
  };
  const onHotbarDown = (/** @type {PointerEvent} */ e) => {
    if (!active) return;
    const target = /** @type {HTMLElement|null} */ (e.target);
    const slot = target && typeof target.closest === 'function' ? /** @type {HTMLElement|null} */ (target.closest('.hotbar-slot')) : null;
    const code = slot ? hotbarCode(slot.dataset.slot) : null;
    if (!code) return;
    if (typeof hooks.onTouch === 'function') hooks.onTouch();
    controls.virtualKey(code, true);
    controls.virtualKey(code, false);
  };
  /**
   * The click that follows a button's tap lands on whatever that tap opened (the pack, a book): it is swallowed. Never a
   * click on the controls themselves or on Back (no tap opens anything under Back, so a click there is the player's own).
   */
  const onClickCapture = (/** @type {MouseEvent} */ e) => {
    if (swallowUntil === 0) return;
    const fresh = now() <= swallowUntil;
    swallowUntil = 0;
    const target = /** @type {Node|null} */ (/** @type {unknown} */ (e.target));
    if (!fresh || !target || layer.contains(target) || back.contains(target)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const prevent = (/** @type {Event} */ e) => {
    if (e.cancelable !== false && typeof e.preventDefault === 'function') e.preventDefault();
  };
  const onBack = () => {
    if (typeof hooks.onBack === 'function') hooks.onBack();
  };

  layer.addEventListener('pointerdown', onDown);
  layer.addEventListener('pointermove', onMove);
  layer.addEventListener('pointerup', onUp);
  layer.addEventListener('pointercancel', onUp);
  layer.addEventListener('lostpointercapture', onUp);
  layer.addEventListener('touchmove', prevent, { passive: false });
  layer.addEventListener('contextmenu', prevent);
  doc.addEventListener('click', onClickCapture, true);
  doc.addEventListener('gesturestart', prevent); // Safari's pinch zoom
  back.addEventListener('click', onBack);
  const hotbar = doc.getElementById('hotbar');
  if (hotbar) hotbar.addEventListener('pointerdown', onHotbarDown);

  // ---- drawing (DOM writes only on change) ----
  /** @type {Map<string, string>} */
  const lastClass = new Map();
  const setFlag = (/** @type {HTMLElement} */ el, /** @type {string} */ key, /** @type {string} */ cls, /** @type {boolean} */ on) => {
    const k = `${key}:${cls}`;
    const v = on ? '1' : '0';
    if (lastClass.get(k) === v) return;
    lastClass.set(k, v);
    el.classList.toggle(cls, on);
  };
  /** @type {Map<HTMLElement, string>} */
  const lastText = new Map();
  const setText = (/** @type {HTMLElement} */ el, /** @type {string} */ text) => {
    if (lastText.get(el) === text) return;
    lastText.set(el, text);
    el.textContent = text;
  };
  let stickShown = '';
  function drawStick() {
    const s = pad.stick;
    const key = s.id === null ? 'idle' : `${s.baseX},${s.baseY},${s.knobX.toFixed(1)},${s.knobY.toFixed(1)},${s.sprint}`;
    if (key === stickShown) return;
    stickShown = key;
    if (s.id === null) {
      stickEl.classList.add('idle');
      stickEl.classList.remove('sprint');
      stickEl.style.left = '';
      stickEl.style.top = '';
      knob.style.transform = '';
    } else {
      stickEl.classList.remove('idle');
      stickEl.classList.toggle('sprint', s.sprint);
      stickEl.style.left = `${s.baseX}px`;
      stickEl.style.top = `${s.baseY}px`;
      knob.style.transform = `translate(${s.knobX.toFixed(1)}px, ${s.knobY.toFixed(1)}px)`;
    }
  }
  /** @type {TouchView} */
  let lastView = { playing: false };
  function draw() {
    for (const [id, el] of buttons) setFlag(el, id, 'pressed', pad.held.has(id));
    const sneak = /** @type {HTMLElement} */ (buttons.get('sneak'));
    setFlag(sneak, 'sneak', 'on', pad.sneakOn);
    setText(sneak, pad.flying ? 'Down' : TOUCH_BUTTONS.sneak.label);
    // flying shows on Jump (a double tap of it took off; another lands)
    setFlag(/** @type {HTMLElement} */ (buttons.get('jump')), 'jump', 'on', !!lastView.flying);
    setText(/** @type {HTMLElement} */ (buttons.get('pack')), lastView.survival ? TOUCH_BUTTONS.pack.label : 'Blocks');
    // §103: the Zoom button only while a Spyglass is carried, lit while the zoom is kept up
    const zoom = /** @type {HTMLElement} */ (buttons.get('zoom'));
    setFlag(zoom, 'zoom', 'hidden', !topButtonShown('zoom', lastView));
    setFlag(zoom, 'zoom', 'on', !!lastView.zoomOn);
    drawStick();
  }

  /** @param {TouchView} view */
  function update(view) {
    const playing = !!(view && view.playing);
    lastView = view || { playing: false };
    if (playing !== active) {
      active = playing;
      if (!active) {
        pad.reset();
        buttonPointers.clear();
      }
      layer.classList.toggle('hidden', !active);
    }
    setFlag(back, 'back', 'hidden', !lastView.back);
    if (active) pad.frame(!!lastView.flying);
    draw();
  }

  function dispose() {
    pad.reset();
    layer.removeEventListener('pointerdown', onDown);
    layer.removeEventListener('pointermove', onMove);
    layer.removeEventListener('pointerup', onUp);
    layer.removeEventListener('pointercancel', onUp);
    layer.removeEventListener('lostpointercapture', onUp);
    layer.removeEventListener('touchmove', prevent);
    layer.removeEventListener('contextmenu', prevent);
    doc.removeEventListener('click', onClickCapture, true);
    doc.removeEventListener('gesturestart', prevent);
    back.removeEventListener('click', onBack);
    if (hotbar) hotbar.removeEventListener('pointerdown', onHotbarDown);
    layer.remove();
    back.remove();
    if (ctp && ctpText !== null) ctp.textContent = ctpText;
    doc.documentElement.classList.remove('touch');
  }

  draw();
  return { update, pad, dispose };
}
