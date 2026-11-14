// Caelancraft — the view modes and the third-person camera (PURE: no three, no DOM). See src/CONTRACTS.md §91.
//
// V cycles first person → third person (behind) → third person (in front, looking back at the avatar's face) → first
// person. In both third-person modes the camera hangs on a BOOM from the eye along the look direction (behind: back along
// it; in front: forward along it), VIEW_BOOM_LENGTH long. A ray to where the camera would be and four to the corners of a
// square VIEW_BOOM_SPREAD round it are cast through the hex grid (raycast.js) against solid or opaque cells; the boom stops
// VIEW_BOOM_MARGIN short of the nearest hit, so the near plane never cuts into a block. A shortened boom snaps in at once
// and eases back out (easeBoom). Aiming, digging, placing and striking still go from the EYE along the look: only the
// camera moves.
import { VIEW_BOOM_LENGTH, VIEW_BOOM_MARGIN, VIEW_BOOM_SPREAD, VIEW_BOOM_EASE } from './config.js';
import { isSolid, isOpaque } from './blocks.js';
import { raycastHex } from './raycast.js';

/** @typedef {'first'|'behind'|'front'} ViewMode */

/** The view modes in V's order. */
export const VIEW_MODES = Object.freeze(/** @type {ViewMode[]} */ (['first', 'behind', 'front']));
/** What the toast says when V switches to each. */
export const VIEW_LABELS = Object.freeze({ first: 'First person view', behind: 'Third person view', front: 'Front view' });
/** localStorage key of the view mode, a per-player preference like the avatar (absent: first person). */
export const VIEW_PREF_KEY = 'caelancraft:v2:view';

/**
 * A view mode from anything: 'first', 'behind' or 'front' (case-insensitive; 'third' is 'behind'), else null.
 * @param {*} v
 * @returns {ViewMode|null}
 */
export function normalizeViewMode(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  if (t === 'third') return 'behind';
  return VIEW_MODES.includes(/** @type {ViewMode} */ (t)) ? /** @type {ViewMode} */ (t) : null;
}

/**
 * The mode V switches to.
 * @param {ViewMode} mode
 * @returns {ViewMode}
 */
export function nextViewMode(mode) {
  const i = VIEW_MODES.indexOf(mode);
  return VIEW_MODES[(i + 1) % VIEW_MODES.length];
}

/** @param {ViewMode} mode @returns {boolean} the avatar is seen from outside */
export function isThirdPerson(mode) {
  return mode === 'behind' || mode === 'front';
}

/**
 * The stored view mode ('first' when there is none or the store cannot be read).
 * @param {{ getItem(k: string): string|null }|null|undefined} storage
 * @returns {ViewMode}
 */
export function loadViewPref(storage) {
  try {
    return (storage && normalizeViewMode(storage.getItem(VIEW_PREF_KEY))) || 'first';
  } catch {
    return 'first';
  }
}

/**
 * Keep the view mode (first person removes the key).
 * @param {{ setItem(k: string, v: string): void, removeItem(k: string): void }|null|undefined} storage
 * @param {ViewMode} mode
 * @returns {boolean} it was stored
 */
export function saveViewPref(storage, mode) {
  const m = normalizeViewMode(mode);
  if (!storage || !m) return false;
  try {
    if (m === 'first') storage.removeItem(VIEW_PREF_KEY);
    else storage.setItem(VIEW_PREF_KEY, m);
    return true;
  } catch {
    return false;
  }
}

/** @param {number} id @returns {boolean} the camera cannot be in this cell (solid or opaque) */
export function blocksCamera(id) {
  return isSolid(id) || isOpaque(id);
}

/**
 * The look direction of yaw / pitch (coords.lookDirection: yaw 0 faces −Z, positive yaw turns left, positive pitch up).
 * @param {number} yaw @param {number} pitch
 * @returns {[number, number, number]}
 */
export function lookVector(yaw, pitch) {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}

/**
 * Which way the boom runs from the eye: back along the look (behind), forward along it (front); null in first person.
 * @param {number} yaw @param {number} pitch @param {ViewMode} mode
 * @returns {[number, number, number]|null}
 */
export function boomDirection(yaw, pitch, mode) {
  if (!isThirdPerson(mode)) return null;
  const [x, y, z] = lookVector(yaw, pitch);
  return mode === 'behind' ? [-x, -y, -z] : [x, y, z];
}

/**
 * How long the boom can be: VIEW_BOOM_LENGTH unless a solid or opaque cell is in the way of the ray from the eye to where
 * the camera would stand or of the rays to the corners of a square `spread` round that point (across the boom, along the
 * camera's right and up); then the nearest hit, along the boom, less `margin`. 0 in first person, never below 0.
 * @param {import('./types.js').GetBlockFn} getBlock  cell → block id
 * @param {number} ex @param {number} ey @param {number} ez  the eye (world)
 * @param {number} yaw @param {number} pitch  the look
 * @param {ViewMode} mode
 * @param {{ length?: number, margin?: number, spread?: number }} [opts]
 * @returns {number}
 */
export function boomLength(getBlock, ex, ey, ez, yaw, pitch, mode, opts = {}) {
  const dir = boomDirection(yaw, pitch, mode);
  if (!dir) return 0;
  const L = opts.length ?? VIEW_BOOM_LENGTH;
  const margin = opts.margin ?? VIEW_BOOM_MARGIN;
  const spread = opts.spread ?? VIEW_BOOM_SPREAD;
  if (!(L > 0)) return 0;
  // the camera's right (level) and up, across the boom
  const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const up = [
    dir[1] * right[2] - dir[2] * right[1],
    dir[2] * right[0] - dir[0] * right[2],
    dir[0] * right[1] - dir[1] * right[0],
  ];
  const ul = Math.hypot(up[0], up[1], up[2]) || 1;
  let best = L;
  for (let k = 0; k < 5; k++) {
    const a = k === 0 ? 0 : k <= 2 ? spread : -spread; // across, along right
    const b = k === 0 ? 0 : k % 2 === 1 ? spread : -spread; // across, along up
    const tx = dir[0] * L + right[0] * a + (up[0] / ul) * b;
    const ty = dir[1] * L + right[1] * a + (up[1] / ul) * b;
    const tz = dir[2] * L + right[2] * a + (up[2] / ul) * b;
    const len = Math.hypot(tx, ty, tz);
    // reach past the camera by the margin too, so a block just behind it also pulls it in
    const reach = len * (1 + margin / L);
    const hit = raycastHex(getBlock, ex, ey, ez, tx, ty, tz, reach, blocksCamera);
    if (!hit) continue;
    // a point `hit.distance` along this ray is (hit.distance / len) of the way out along the boom
    best = Math.min(best, (hit.distance / len) * L - margin);
  }
  return Math.max(0, best);
}

/**
 * The boom from one frame to the next: shorter at once (the camera never goes through a block), longer by easing at
 * `rate` per second (so it slides back out instead of jumping when the way clears).
 * @param {number} current
 * @param {number} target
 * @param {number} dt  seconds
 * @param {number} [rate=VIEW_BOOM_EASE]
 * @returns {number}
 */
export function easeBoom(current, target, dt, rate = VIEW_BOOM_EASE) {
  if (!Number.isFinite(current) || target <= current) return target;
  const k = 1 - Math.exp(-Math.max(0, dt) * rate);
  const next = current + (target - current) * k;
  return target - next < 1e-3 ? target : next;
}

/**
 * Where the camera is and which way it looks for a view mode and a boom: first person at the eye along the look; behind,
 * `boom` back along the look, looking along it; in front, `boom` forward along the look, looking back (yaw + π, −pitch).
 * @param {number} ex @param {number} ey @param {number} ez
 * @param {number} yaw @param {number} pitch
 * @param {ViewMode} mode
 * @param {number} boom
 * @param {{ x: number, y: number, z: number, yaw: number, pitch: number }} [out]
 */
export function cameraPose(ex, ey, ez, yaw, pitch, mode, boom, out = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }) {
  const dir = boomDirection(yaw, pitch, mode);
  const b = dir && boom > 0 ? boom : 0;
  out.x = ex + (dir ? dir[0] * b : 0);
  out.y = ey + (dir ? dir[1] * b : 0);
  out.z = ez + (dir ? dir[2] * b : 0);
  if (mode === 'front') {
    const turned = yaw + Math.PI;
    out.yaw = turned > Math.PI ? turned - 2 * Math.PI : turned;
    out.pitch = -pitch;
  } else {
    out.yaw = yaw;
    out.pitch = pitch;
  }
  return out;
}
