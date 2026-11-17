// Caelancraft — the Spyglass (CONTRACTS §103). PURE: no DOM, no three.
//
// The user: "spyglass: requires bronze + glass. Unlocks spyglass zoom + zoom command when in the player's inventory."
// While a Spyglass is carried (Survival: anywhere in the pack; Creative: an item pick on the Creative hotbar, §98), the
// player can look through it:
//   - HOLD: Z held (or Place held with the Spyglass in hand) looks through it while held; let go and the view returns;
//   - LOCK: the console's `zoom [2|4|8]` keeps looking through it until `zoom off`, Esc or a menu (main ends it); so does
//     the tablet's Zoom button, a tap a power: 2×, 4×, 8×, then down (a tablet has no wheel);
//   - the wheel steps the power through ZOOM_LEVELS (2×, 4×, 8×) while looking.
// Looking, the view narrows smoothly to the power (`fov`), the look slows by it (`lookScale`), a round dark eyepiece
// closes in at the screen's edge (`vignette`) and the first-person hand is put away (`handHidden`). A Spyglass that is
// no longer carried ends both at once. Main owns the keys, the menus and the drawing; this module only keeps the state.

/** The item that is the Spyglass. */
export const SPYGLASS_KEY = 'spyglass';
/** The key held to look through it. */
export const ZOOM_KEY = 'KeyZ';
/** The powers it has, in order; the wheel steps through them. */
export const ZOOM_LEVELS = Object.freeze([2, 4, 8]);
/** The power it starts at (and goes back to with `zoom` alone after a reload). */
export const ZOOM_DEFAULT = 4;
/** How fast the view narrows and widens (per second, in the log of the power: about 0.3 s to settle). */
export const ZOOM_EASE = 12;
/** The view counts as looking through the glass (the hand is away) above this power. */
export const ZOOM_HAND_AT = 1.05;
/** What the zoom command (and the Zoom button) answer without a Spyglass. */
export const SPYGLASS_NEEDED = 'You need a spyglass';

/**
 * Place with the Spyglass in hand (main's glassPlaceStep, both modes): whether this frame's Place is the glass's, and
 * whether it is held to look through it. Not in hand, it is not. A press on a circuit control without Shift (`control`)
 * is the control's, and so is every frame while the control latch holds one that Place pressed (`latched`, §4.9): a Push
 * Button stays pressed, and the glass does not come up.
 * @param {{ inHand: boolean, rightPressed: boolean, right: boolean, control: boolean, latched: boolean }} e
 * @returns {{ mine: boolean, held: boolean }}
 */
export function glassPlace(e) {
  if (!e.inHand || e.latched || (e.rightPressed && e.control)) return { mine: false, held: false };
  return { mine: true, held: !!e.right };
}

/**
 * The hint with the Spyglass in hand. Not looking: "Spyglass · Hold RMB or Z to look through it" (a tablet's words come
 * from touchWords, §97.2). Looking: the power, and how to change it — the wheel on a keyboard; on a tablet the Zoom
 * button while it keeps the glass up (closer, or down from the last power), else just the power.
 * @param {{ looking: boolean, locked: boolean, zoom: number }} glass @param {boolean} touch
 * @returns {string}
 */
export function glassHint(glass, touch) {
  if (!glass.looking) return 'Spyglass · Hold RMB or Z to look through it';
  const head = `Spyglass ${zoomLabel(glass.zoom)}`;
  if (!touch) return `${head} · scroll: closer or farther`;
  if (!glass.locked) return head;
  return glass.zoom < ZOOM_LEVELS[ZOOM_LEVELS.length - 1] ? `${head} · tap Zoom: closer` : `${head} · tap Zoom to put it down`;
}

/**
 * Is a Spyglass carried? Survival: the pack holds one anywhere (`count`); Creative: one of the Creative hotbar's picks is
 * the Spyglass (an item pick, §98).
 * @param {{ survival: boolean, count?: (key: string) => number, hotbar?: ReadonlyArray<number|string|null>|null }} where
 * @returns {boolean}
 */
export function carriesSpyglass(where) {
  if (!where) return false;
  if (where.survival) return typeof where.count === 'function' && Number(where.count(SPYGLASS_KEY)) > 0;
  return Array.isArray(where.hotbar) && where.hotbar.includes(SPYGLASS_KEY);
}

/**
 * The field of view (degrees, vertical) through a glass of power `zoom`: the angle whose tangent is the view's divided by
 * the power, so everything looks `zoom` times bigger. A power of 1 (or anything not above 1) leaves it unchanged.
 * @param {number} fovDeg @param {number} zoom @returns {number}
 */
export function zoomedFov(fovDeg, zoom) {
  if (!(zoom > 1) || !Number.isFinite(fovDeg)) return fovDeg;
  const half = (fovDeg * Math.PI) / 360;
  return (Math.atan(Math.tan(half) / zoom) * 360) / Math.PI;
}

/** The share of the look's sensitivity at power `zoom`: 1 / zoom (1 at no zoom). @param {number} zoom */
export function zoomLookScale(zoom) {
  return zoom > 1 && Number.isFinite(zoom) ? 1 / zoom : 1;
}

/**
 * The power after `notches` wheel steps from `zoom`: scrolling up (negative notches) looks closer, down farther, one
 * level a notch, stopping at the ends (2× and 8×). A power that is not a level starts from ZOOM_DEFAULT.
 * @param {number} zoom @param {number} notches @returns {number}
 */
export function wheelZoom(zoom, notches) {
  let i = ZOOM_LEVELS.indexOf(zoom);
  if (i < 0) i = ZOOM_LEVELS.indexOf(ZOOM_DEFAULT);
  if (!Number.isFinite(notches) || notches === 0) return ZOOM_LEVELS[i];
  const steps = Math.max(1, Math.round(Math.abs(notches)));
  const j = i + (notches < 0 ? steps : -steps);
  return ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, j))];
}

/**
 * The zoom command's argument: '2', '4', '8' (also '2x', '4×') → `{ zoom }`; 'off' → `{ off: true }`; none → `{ zoom:
 * null }` (the power it has); anything else null.
 * @param {string|undefined|null} arg
 * @returns {{ zoom: number|null }|{ off: true }|null}
 */
export function parseZoomArg(arg) {
  if (arg === undefined || arg === null || String(arg).trim() === '') return { zoom: null };
  const t = String(arg).trim().toLowerCase().replace(/[x×]$/, '');
  if (t === 'off') return { off: true };
  const n = Number(t);
  return ZOOM_LEVELS.includes(n) ? { zoom: n } : null;
}

/**
 * On a server every console line is said to everyone and commands are off (§96) — but `zoom` changes only this player's
 * own view, so main runs it there too. The line to run for `line` when it is the zoom command, or null (say it): `/zoom
 * …` always is (its mistakes get the usage); without the slash only a whole zoom command is (`zoom`, `zoom 4`, `zoom
 * off`), so "zoom zoom!" is still said. @param {string} line @returns {string|null}
 */
export function serverZoomLine(line) {
  const m = /^(\/?)zoom(?:\s+(.*))?$/i.exec(String(line ?? '').trim());
  if (!m) return null;
  const arg = (m[2] ?? '').trim();
  if (!m[1] && arg !== '' && parseZoomArg(arg) === null) return null;
  return arg ? `zoom ${arg}` : 'zoom';
}

/** "4×" @param {number} zoom */
export function zoomLabel(zoom) {
  return `${zoom}×`;
}

/** The state of looking through the Spyglass: held, locked, the power, and the power the view shows (eased). */
export class Spyglass {
  constructor() {
    /** The power looked through (a ZOOM_LEVELS entry). */
    this.zoom = ZOOM_DEFAULT;
    /** Z (or Place with the glass in hand) is held this frame. */
    this.held = false;
    /** The zoom command (or the Zoom button) keeps the glass up. */
    this.locked = false;
    /** The power the view shows now (1: none), eased toward `zoom` while looking and back to 1 after. */
    this.shown = 1;
  }

  /** @returns {boolean} looking through the glass: held or locked */
  get looking() {
    return this.held || this.locked;
  }

  /**
   * One frame: whether a Spyglass is carried and whether Z (or Place with it in hand) is held; then the shown power eases
   * toward where it is going. Not carried, neither holding nor the lock can last.
   * @param {number} dt @param {{ carried: boolean, held: boolean }} input
   */
  step(dt, input) {
    const carried = !!(input && input.carried);
    this.held = carried && !!input.held;
    if (!carried) this.locked = false;
    const target = this.looking ? this.zoom : 1;
    const t = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const k = 1 - Math.exp(-ZOOM_EASE * t);
    const a = Math.log(this.shown);
    const b = Math.log(target);
    const next = a + (b - a) * k;
    this.shown = Math.abs(next - b) < 0.002 ? target : Math.exp(next);
  }

  /**
   * Keep looking at power `zoom` (null: the power it has) until `unlock`. @param {number|null} [zoom]
   * @returns {number} the power
   */
  lock(zoom = null) {
    if (zoom !== null && ZOOM_LEVELS.includes(zoom)) this.zoom = zoom;
    this.locked = true;
    return this.zoom;
  }

  /** Stop the lock (zoom off, Esc, a menu). @returns {boolean} it was locked */
  unlock() {
    const was = this.locked;
    this.locked = false;
    return was;
  }

  /** Lock at the power it has, or let go of the lock. @returns {boolean} now locked */
  toggle() {
    if (this.locked) this.unlock();
    else this.lock();
    return this.locked;
  }

  /**
   * The tablet's Zoom button (a tablet has no wheel): up at the lowest power, a tap a power closer, and down after the
   * highest — 2×, 4×, 8×, down. @returns {number} the power now, 0 when it put the glass down
   */
  button() {
    if (!this.locked) return this.lock(ZOOM_LEVELS[0]);
    const i = ZOOM_LEVELS.indexOf(this.zoom);
    if (i >= 0 && i < ZOOM_LEVELS.length - 1) return this.lock(ZOOM_LEVELS[i + 1]);
    this.unlock();
    return 0;
  }

  /**
   * The wheel while looking steps the power; not looking, it is not for the glass.
   * @param {number} notches @returns {boolean} the wheel was used here (main does not change the hotbar slot)
   */
  wheel(notches) {
    if (!this.looking || !Number.isFinite(notches) || notches === 0) return false;
    this.zoom = wheelZoom(this.zoom, notches);
    return true;
  }

  /** The field of view through the glass now, from the view's own `fovDeg`. @param {number} fovDeg */
  fov(fovDeg) {
    return zoomedFov(fovDeg, this.shown);
  }

  /** The look's sensitivity share now: it slows by the power shown. */
  lookScale() {
    return zoomLookScale(this.shown);
  }

  /** How dark the round eyepiece is now, 0..1: full from a power of 2. */
  vignette() {
    return this.shown > 1 ? Math.min(1, Math.log(this.shown) / Math.log(ZOOM_LEVELS[0])) : 0;
  }

  /** The first-person hand is put away: looking, or the view still narrowed. */
  get handHidden() {
    return this.looking || this.shown > ZOOM_HAND_AT;
  }

  /** Back to rest at once, at the power it starts at (leaving a world: main's resetSpyglass). */
  reset() {
    this.held = false;
    this.locked = false;
    this.shown = 1;
    this.zoom = ZOOM_DEFAULT;
  }
}
