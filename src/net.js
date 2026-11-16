// Caelancraft — the multiplayer client (docs/DESIGN-multiplayer.md §2–§3). PURE: the WebSocket constructor, `fetch`,
// the storage and the clock are injected, so the tests run it under Node.
//
// NetClient keeps the connection: it says hello, queues every message from the server in an inbox that main drains once a
// frame (the world is only ever changed inside the frame), and sends the player's pose and intents. RemotePlayers keeps
// the other players' recent poses and gives each one's pose a little in the past, interpolated, so they move smoothly
// between the server's 15 updates a second.
import {
  PROTOCOL_VERSION, WS_PATH, INFO_PATH, POSE_SWING, encode, decode, cleanName, cleanChat, cleanPose,
} from './protocol.js';

/** Remote players are drawn this far in the past (s), between the two poses that surround that moment. */
export const REMOTE_DELAY_S = 0.12;
/** Poses kept per remote player. */
const POSE_BUFFER = 12;
/** The browser's key for this browser's player token (the server knows a returning player by it). */
export const TOKEN_KEY = 'caelancraft:v2:mp-token';

/**
 * The WebSocket address of the server that served this page, or of `?server=host[:port]`.
 * @param {{ protocol: string, host: string }} loc  window.location
 * @param {string|null} [override]  `host[:port]` from ?server=
 * @returns {string}
 */
export function serverWsUrl(loc, override = null) {
  const secure = loc.protocol === 'https:';
  const host = override && /^[A-Za-z0-9.:[\]-]+$/.test(override) ? override : loc.host;
  return `${secure ? 'wss' : 'ws'}://${host}${WS_PATH}`;
}

/**
 * Ask the page's server (or `override`) what it is. Resolves `null` when there is no game server there (a plain static
 * host, the Vite dev server, a network error) or it speaks another protocol version (then `{ …, mismatch: true }`).
 * @param {(url: string) => Promise<any>} fetchImpl
 * @param {{ protocol: string, host: string }} loc
 * @param {string|null} [override]
 * @returns {Promise<{ name: string, version: number, players: number, mode: string, mismatch?: boolean }|null>}
 */
export async function probeServer(fetchImpl, loc, override = null) {
  try {
    const host = override && /^[A-Za-z0-9.:[\]-]+$/.test(override) ? override : loc.host;
    const res = await fetchImpl(`${loc.protocol}//${host}${INFO_PATH}`);
    if (!res || !res.ok) return null;
    const info = await res.json();
    if (!info || typeof info !== 'object' || !Number.isInteger(info.version)) return null;
    return {
      name: cleanName(info.name, 'Caelancraft'), version: info.version, players: Number(info.players) || 0,
      mode: info.mode === 'survival' ? 'survival' : 'creative', mismatch: info.version !== PROTOCOL_VERSION || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * This browser's player token (made once and kept): the server gives a returning player back their name, avatar and
 * place. Works without storage (a fresh token each time).
 * @param {{ getItem(k: string): string|null, setItem(k: string, v: string): void }|null} storage
 * @param {() => number} [random]
 */
export function playerToken(storage, random = Math.random) {
  try {
    const t = storage && storage.getItem(TOKEN_KEY);
    if (t && /^[A-Za-z0-9-]{8,64}$/.test(t)) return t;
  } catch {
    // no storage: a fresh token
  }
  const t = Array.from({ length: 4 }, () => Math.floor(random() * 2 ** 32).toString(16).padStart(8, '0')).join('-');
  try {
    if (storage) storage.setItem(TOKEN_KEY, t);
  } catch {
    // private mode: the token lasts this page only
  }
  return t;
}

export class NetClient {
  /**
   * @param {{ url: string, WebSocketImpl: any, name: string, avatar: string, token: string }} opts
   */
  constructor(opts) {
    this.url = opts.url;
    this.WebSocketImpl = opts.WebSocketImpl;
    this.name = opts.name;
    this.avatar = opts.avatar;
    this.token = opts.token;
    /** 'idle' | 'connecting' | 'open' (hello sent) | 'joined' (welcome received) | 'closed' */
    this.state = 'idle';
    /** @type {any[]} messages from the server not yet handled */
    this.inbox = [];
    /** why the connection ended ('' while it lasts) */
    this.closedReason = '';
    /** our player id on the server (from welcome) */
    this.id = 0;
    /** @type {any} */
    this.ws = null;
  }

  connect() {
    if (this.state !== 'idle') return;
    this.state = 'connecting';
    let ws;
    try {
      ws = new this.WebSocketImpl(this.url);
    } catch (e) {
      this._closed(`could not connect: ${e && e.message ? e.message : e}`);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.state = 'open';
      this._send({ t: 'hello', v: PROTOCOL_VERSION, name: this.name, avatar: this.avatar, token: this.token });
    };
    ws.onmessage = (ev) => {
      const msg = decode(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (!msg) return;
      if (msg.t === 'welcome') {
        this.state = 'joined';
        this.id = msg.id;
      } else if (msg.t === 'refused') {
        this.closedReason = typeof msg.reason === 'string' ? msg.reason : 'refused';
      }
      this.inbox.push(msg);
    };
    ws.onclose = (ev) => this._closed(this.closedReason || (ev && ev.reason) || (this.state === 'joined' ? 'the server closed the connection' : 'could not reach the server'));
    ws.onerror = () => {};
  }

  /** @param {string} reason */
  _closed(reason) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.closedReason = reason;
    this.inbox.push({ t: 'closed', reason });
  }

  /** Hand every queued message to `handle`, oldest first, and empty the inbox. @param {(msg: any) => void} handle */
  drain(handle) {
    const msgs = this.inbox;
    this.inbox = [];
    for (const m of msgs) handle(m);
  }

  /** @param {object} msg */
  _send(msg) {
    const ws = this.ws;
    if (ws && ws.readyState === 1) ws.send(encode(msg));
  }

  /** @param {import('./protocol.js').Pose} pose */
  sendPose(pose) {
    if (this.state === 'joined') this._send({ t: 'pose', ...pose });
  }

  /** A hex cell the player changed (AIR: broke it). */
  sendSet(q, y, r, id) {
    if (this.state === 'joined') this._send({ t: 'set', q, y, r, id });
  }

  /** A brick the player laid (AIR: took away). */
  sendBrick(i, y, n, id) {
    if (this.state === 'joined') this._send({ t: 'brick', i, y, n, id });
  }

  /** @param {string} text */
  sendChat(text) {
    const t = cleanChat(text);
    if (t && this.state === 'joined') this._send({ t: 'chat', text: t });
  }

  /** Leave: nothing more is queued (not even the `closed` of our own closing). */
  close() {
    const ws = this.ws;
    const open = this.state !== 'closed';
    this.state = 'closed';
    if (ws && open) {
      ws.onmessage = null;
      try {
        ws.close(1000, 'left');
      } catch {
        // already closing
      }
    }
  }
}

/**
 * @typedef {Object} RemotePlayer
 * @property {number} id
 * @property {string} name
 * @property {string} avatar
 * @property {Array<{ t: number, pose: import('./protocol.js').Pose }>} buffer  received poses, oldest first
 * @property {number} swings  how many poses with POSE_SWING arrived (the renderer swings the arm when it goes up)
 */

/** Shortest turn from angle a to b (radians), in (−π, π]. */
function turn(a, b) {
  const tau = Math.PI * 2;
  let d = (b - a) % tau;
  if (d > Math.PI) d -= tau;
  if (d <= -Math.PI) d += tau;
  return d;
}

export class RemotePlayers {
  constructor() {
    /** @type {Map<number, RemotePlayer>} */
    this.map = new Map();
  }

  /** @param {{ id: number, name: string, avatar: string, pose: any }} p @param {number} t  local seconds */
  join(p, t) {
    const pose = cleanPose(p.pose);
    /** @type {RemotePlayer} */
    const rp = { id: p.id, name: cleanName(p.name), avatar: typeof p.avatar === 'string' ? p.avatar : 'caelan', buffer: [], swings: 0 };
    if (pose) rp.buffer.push({ t, pose });
    this.map.set(p.id, rp);
  }

  /** @param {number} id */
  leave(id) {
    this.map.delete(id);
  }

  clear() {
    this.map.clear();
  }

  /** A pose received for player `id` at local time `t`. @param {number} id @param {any} pose @param {number} t */
  push(id, pose, t) {
    const rp = this.map.get(id);
    const p = cleanPose(pose);
    if (!rp || !p) return;
    if (p.flags & POSE_SWING) rp.swings++;
    rp.buffer.push({ t, pose: p });
    if (rp.buffer.length > POSE_BUFFER) rp.buffer.splice(0, rp.buffer.length - POSE_BUFFER);
  }

  /**
   * Player `id`'s pose at local time `t − REMOTE_DELAY_S`: between the two received poses round that moment (position
   * linear, yaw the short way round), the newest when the moment is past them all, the oldest before them all.
   * @param {number} id @param {number} t
   * @returns {import('./protocol.js').Pose|null}
   */
  sample(id, t) {
    const rp = this.map.get(id);
    if (!rp || rp.buffer.length === 0) return null;
    const at = t - REMOTE_DELAY_S;
    const b = rp.buffer;
    if (at <= b[0].t) return b[0].pose;
    for (let k = 1; k < b.length; k++) {
      if (b[k].t >= at) {
        const a = b[k - 1];
        const c = b[k];
        const f = c.t > a.t ? (at - a.t) / (c.t - a.t) : 1;
        const pa = a.pose;
        const pc = c.pose;
        return {
          x: pa.x + (pc.x - pa.x) * f, y: pa.y + (pc.y - pa.y) * f, z: pa.z + (pc.z - pa.z) * f,
          yaw: pa.yaw + turn(pa.yaw, pc.yaw) * f, pitch: pa.pitch + (pc.pitch - pa.pitch) * f,
          flags: f < 0.5 ? pa.flags : pc.flags, vx: pa.vx + (pc.vx - pa.vx) * f, vz: pa.vz + (pc.vz - pa.vz) * f,
        };
      }
    }
    return b[b.length - 1].pose;
  }

  /** @returns {RemotePlayer[]} */
  list() {
    return [...this.map.values()];
  }
}
