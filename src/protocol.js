// Caelancraft — the multiplayer protocol (docs/DESIGN-multiplayer.md §3). PURE: shared by the server (Node) and the
// browser client. Messages are JSON objects with a type `t`; this module holds the constants, the encoder and decoder,
// and the cleaners that turn whatever arrives over the wire into well-formed values (or null), so neither end ever trusts
// the other's numbers.
import { WORLD_HEIGHT } from './config.js';
import { getItem } from './items.js';

/** Bumped whenever a message changes shape; a client and a server of different versions refuse each other. */
export const PROTOCOL_VERSION = 1;
/** The server's default port (one port: the game's files and the WebSocket). */
export const DEFAULT_PORT = 4180;
/** The WebSocket's path on that port. */
export const WS_PATH = '/ws';
/** What the server says about itself at this path (JSON): `{ name, version, players, mode }`. */
export const INFO_PATH = '/api/info';
/** How often a client sends its pose, and the server the others' (per second). */
export const POSE_HZ = 15;
/** How often the server sends the clock (seconds); clients run it between. */
export const TIME_SYNC_S = 5;
/** Longest player name and chat line. */
export const MAX_NAME = 20;
export const MAX_CHAT = 200;
/** A client message longer than this is dropped unread (bytes of text). */
export const MAX_CLIENT_MESSAGE = 16 * 1024;
/** Most players on one server (phase 1: a family; phase 4 makes it configurable). */
export const MAX_PLAYERS = 8;

/** Why the server closes a connection whose browser joined again (another tab, a reload): never rejoined by itself. */
export const REPLACED_REASON = 'joined again from elsewhere';

/** Pose flag bits. */
export const POSE_FLYING = 1;
export const POSE_SNEAKING = 2;
export const POSE_ON_GROUND = 4;
export const POSE_SWING = 8;
export const POSE_SWIMMING = 16;
/** §100: Place is held with a spear, a dart or a bow — the others see the draw. */
export const POSE_DRAWING = 32;
/** Every pose flag: anything else that arrives is dropped. */
export const POSE_FLAGS = 63;

/** @param {object} msg @returns {string} */
export function encode(msg) {
  return JSON.stringify(msg);
}

/**
 * @param {unknown} text  what arrived (a string; a Buffer's text on the server)
 * @param {number} [maxLength]
 * @returns {{ t: string } & Record<string, any> | null}  the message, or null when it is not a JSON object with a string `t`
 */
export function decode(text, maxLength = Infinity) {
  if (typeof text !== 'string' || text.length > maxLength) return null;
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  return m && typeof m === 'object' && !Array.isArray(m) && typeof m.t === 'string' ? m : null;
}

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
/** Control characters (and DEL): never in a name or a chat line. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_OR_ANGLE = /[\u0000-\u001f\u007f<>]/g;
const int = (v) => Number.isInteger(v);
/** Round to 3 decimals (a millimetre / a milliradian: plenty, and short on the wire). */
const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * A player's name: printable, trimmed, at most MAX_NAME characters; `fallback` when nothing is left.
 * @param {unknown} s @param {string} [fallback]
 */
export function cleanName(s, fallback = 'Player') {
  const t = typeof s === 'string' ? s.replace(CONTROL_OR_ANGLE, '').trim().slice(0, MAX_NAME).trim() : '';
  return t || fallback;
}

/** A chat line: printable, trimmed, at most MAX_CHAT characters; '' when nothing is left. @param {unknown} s */
export function cleanChat(s) {
  return typeof s === 'string' ? s.replace(CONTROL, ' ').trim().slice(0, MAX_CHAT) : '';
}

/**
 * @typedef {Object} Pose  a player's body as the wire carries it
 * @property {number} x @property {number} y @property {number} z  feet, world units
 * @property {number} yaw @property {number} pitch  radians
 * @property {number} flags  POSE_* bits
 * @property {number} vx @property {number} vz  horizontal velocity (m/s), for the walk animation
 */

/**
 * A pose from the wire, or null when any number is missing or absurd. Angles are wrapped / clamped; y is kept within a
 * band round the world's height.
 * @param {any} m @returns {Pose|null}
 */
export function cleanPose(m) {
  if (!m || typeof m !== 'object') return null;
  const { x, y, z, yaw, pitch } = m;
  if (![x, y, z, yaw, pitch].every(fin)) return null;
  if (Math.abs(x) > 1e7 || Math.abs(z) > 1e7 || y < -64 || y > WORLD_HEIGHT + 256) return null;
  const vx = fin(m.vx) ? Math.max(-100, Math.min(100, m.vx)) : 0;
  const vz = fin(m.vz) ? Math.max(-100, Math.min(100, m.vz)) : 0;
  const flags = int(m.flags) ? m.flags & POSE_FLAGS : 0;
  const tau = Math.PI * 2;
  return {
    x, y, z, yaw: ((yaw % tau) + tau) % tau, pitch: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch)), flags, vx, vz,
  };
}

/** @param {number} id @param {Pose} p @returns {number[]} `[id, x, y, z, yaw, pitch, flags, vx, vz]` */
export function packPose(id, p) {
  return [id, r3(p.x), r3(p.y), r3(p.z), r3(p.yaw), r3(p.pitch), p.flags, r3(p.vx), r3(p.vz)];
}

/** @param {any} a @returns {(Pose & { id: number })|null} */
export function unpackPose(a) {
  if (!Array.isArray(a) || a.length < 9 || !int(a[0])) return null;
  const pose = cleanPose({ x: a[1], y: a[2], z: a[3], yaw: a[4], pitch: a[5], flags: a[6], vx: a[7], vz: a[8] });
  return pose ? { id: a[0], ...pose } : null;
}

/**
 * What a player holds (§98): the key of an item of the game, or null (an empty hand, or anything else that arrives).
 * @param {unknown} v @returns {string|null}
 */
export function cleanHeld(v) {
  return typeof v === 'string' && v.length <= 40 && /^[a-z0-9_]+$/.test(v) && getItem(v) ? v : null;
}

/** A hex cell intent `{ q, y, r, id }` (integers; y inside the world; id 0..255), or null. @param {any} m */
export function cleanCell(m) {
  if (!m || typeof m !== 'object') return null;
  const { q, y, r, id } = m;
  if (![q, y, r, id].every(int) || y < 0 || y >= WORLD_HEIGHT || id < 0 || id > 255) return null;
  if (Math.abs(q) > 1e7 || Math.abs(r) > 1e7) return null;
  return { q, y, r, id };
}

/** A brick intent `{ i, y, n, id }` (integers; y inside the world; id 0..255), or null. @param {any} m */
export function cleanBrick(m) {
  if (!m || typeof m !== 'object') return null;
  const { i, y, n, id } = m;
  if (![i, y, n, id].every(int) || y < 0 || y >= WORLD_HEIGHT || id < 0 || id > 255) return null;
  if (Math.abs(i) > 1e7 || Math.abs(n) > 1e7) return null;
  return { i, y, n, id };
}

/**
 * The flat quadruples of a `cells` or `bricks` message, checked: `[a, y, b, id, …]` → `[[a, y, b, id], …]` (malformed
 * entries are skipped). @param {any} flat @returns {number[][]}
 */
export function unflatten4(flat) {
  /** @type {number[][]} */
  const out = [];
  if (!Array.isArray(flat)) return out;
  for (let k = 0; k + 3 < flat.length; k += 4) {
    const a = flat[k];
    const y = flat[k + 1];
    const b = flat[k + 2];
    const id = flat[k + 3];
    if ([a, y, b, id].every(int) && y >= 0 && y < WORLD_HEIGHT && id >= 0 && id <= 255) out.push([a, y, b, id]);
  }
  return out;
}
