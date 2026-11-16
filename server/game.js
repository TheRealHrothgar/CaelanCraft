// Caelancraft — the multiplayer server's game (docs/DESIGN-multiplayer.md §2–§4, phase 1). PURE of networking: a socket
// is anything with `send(text)` and `close(code, reason)`, so the tests drive it with fakes and index.js with `ws`.
//
// The server is the truth about the world: it owns a headless World (no meshes) streamed round every player, the block
// physics (water, falling sand, collapse, blasts) and the clock. Clients generate terrain themselves from the seed and are
// sent only the edits and bricks; their intents (`set`, `brick`) are checked and applied here, and every cell that
// changes — a player's or the physics' — is broadcast once a tick. Phase 1 worlds are Creative.
import { World } from '../src/world.js';
import { BlockPhysics } from '../src/blockphysics.js';
import { BLOCK, BLOCK_COUNT, isBrickMaterial, isBrickShadow, getBlockDef } from '../src/blocks.js';
import { BRICK_DEPTH } from '../src/bricks.js';
import { hexToWorld } from '../src/hex.js';
import { advanceTime } from '../src/daynight.js';
import { GEN_LATEST, START_TIME, REACH } from '../src/config.js';
import { packCell } from '../src/coords.js';
import {
  PROTOCOL_VERSION, MAX_PLAYERS, TIME_SYNC_S, POSE_SWING, REPLACED_REASON, encode, cleanName, cleanChat, cleanPose, packPose, cleanCell,
  cleanBrick, cleanHeld,
} from '../src/protocol.js';
import { AVATAR_IDS, normalizeAvatarId, DEFAULT_AVATAR } from '../src/avatars.js';

/** The save file's own format tag and version (not the browser save's). */
export const SERVER_SAVE_FORMAT = 'caelancraft-server-world';
export const SERVER_SAVE_VERSION = 1;
/** Chunks kept loaded and simulated round each player (a hex disc of this radius, plus one of data). */
export const SIM_RADIUS = 4;
/** The server's tick (s): physics and broadcasts run at 20 Hz. */
export const TICK_S = 0.05;
/** How far past REACH an intent may be from the player's eye (lag and rounding). */
const REACH_SLACK = 3;
/** Wall-clock budget (ms) for generating chunks in one tick. */
const GEN_BUDGET_MS = 12;

/**
 * @typedef {Object} Socket  what the game needs of a connection
 * @property {(text: string) => void} send
 * @property {(code?: number, reason?: string) => void} close
 */

/**
 * @typedef {Object} ServerPlayer
 * @property {number} id
 * @property {string} token
 * @property {string} name
 * @property {string} avatar
 * @property {Socket} socket
 * @property {import('../src/protocol.js').Pose} pose
 * @property {boolean} poseDirty
 * @property {string|null} held  the item in the player's hand (§98: drawn in their avatar's hand for the others)
 */

/** @param {unknown} t @returns {string|null} a token a browser keeps: 8–64 letters, digits, dashes */
function cleanToken(t) {
  return typeof t === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(t) ? t : null;
}

/** A fresh token for a client that sent none. */
function newToken() {
  return Array.from({ length: 4 }, () => Math.floor(Math.random() * 2 ** 32).toString(16).padStart(8, '0')).join('-');
}

export class ServerGame {
  /**
   * @param {{ name?: string, seed?: number|string, gen?: number, save?: any, log?: (line: string) => void,
   *   now?: () => number }} [opts]  `save`: what toJSON() wrote (null: a new world from `seed`)
   */
  constructor(opts = {}) {
    const save = opts.save && opts.save.format === SERVER_SAVE_FORMAT ? opts.save : null;
    this.log = opts.log ?? (() => {});
    this.name = cleanName(save ? save.name : opts.name, 'Caelancraft');
    this.seed = save ? save.seed : opts.seed ?? Math.floor(Math.random() * 2 ** 31);
    this.gen = save ? save.gen : opts.gen ?? GEN_LATEST;
    /** Phase 1: every multiplayer world is Creative (DESIGN-multiplayer §4). */
    this.mode = 'creative';
    this.time = save && Number.isFinite(save.time) ? save.time : START_TIME;
    this.day = save && Number.isFinite(save.day) ? Math.max(1, Math.floor(save.day)) : 1;
    this.world = new World({
      seed: this.seed, gen: this.gen, renderDistance: SIM_RADIUS, edits: save ? save.edits : undefined,
      bricks: save ? save.bricks : undefined, mesh: false, now: opts.now,
    });
    for (const w of this.world.brickWarnings) this.log(`bricks: ${w}`);
    this.physics = new BlockPhysics(this.world, { say: (text) => this.log(`physics: ${text}`) });
    this.physics.importSwitches(save ? save.physics : null);
    this.world.onChunkGenerated = (cq, cr) => this.physics.onChunkGenerated(cq, cr);
    this.world.onCoverChange = (q, y, r) => this.physics.onCoverChange(q, y, r);
    this.world.onBlockChange = (q, y, r, prev, next) => {
      this.physics.onBlockChange(q, y, r, prev, next);
      // a brick's derived shadow is the client's own business (it has the bricks)
      if (isBrickShadow(next) && next !== BLOCK.BRICK_GAP) return;
      this._cells.set(packCell(q, y, r), [q, y, r, next]);
    };
    /** @type {Map<number, number[]>} hex cells changed since the last broadcast */
    this._cells = new Map();
    /** @type {number[]} bricks changed since the last broadcast, flat [i, y, n, id, …] */
    this._bricks = [];
    /** @type {Map<number, ServerPlayer>} */
    this.players = new Map();
    /** @type {Map<string, { name: string, avatar: string, pose: import('../src/protocol.js').Pose|null }>} by token */
    this.records = new Map(Object.entries(save && save.players && typeof save.players === 'object' ? save.players : {}));
    this._nextId = 1;
    this._timeSync = 0;
    this._spawn = null;
    /** Something changed since the last save (the world, the clock or a player). */
    this.dirty = !save;
  }

  /** @returns {number[]} world [x, y, z] where a new player starts */
  get spawn() {
    if (this._spawn === null) this._spawn = this.world.findSpawn();
    return this._spawn;
  }

  /** @returns {{ name: string, version: number, players: number, mode: string }} what `/api/info` says */
  info() {
    return { name: this.name, version: PROTOCOL_VERSION, players: this.players.size, mode: this.mode };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // connections

  /**
   * A connection's first message. Refused (and closed) for another protocol version, a full server or a bad hello;
   * else the player joins: `welcome` to it (the world's seed, edits, bricks, everyone there), `join` to the others. A
   * player whose token is already connected replaces that connection (a reload, a dropped Wi-Fi).
   * @param {Socket} socket @param {any} hello
   * @returns {ServerPlayer|null}
   */
  join(socket, hello) {
    const refuse = (reason) => {
      socket.send(encode({ t: 'refused', reason }));
      socket.close(4000, reason);
      return null;
    };
    if (!hello || hello.t !== 'hello') return refuse('expected hello');
    if (hello.v !== PROTOCOL_VERSION) return refuse(`this server speaks version ${PROTOCOL_VERSION} of the game; reload the page`);
    const token = cleanToken(hello.token) ?? newToken();
    for (const p of this.players.values()) {
      if (p.token === token) this.leave(p, 'replaced'); // the same browser again
    }
    if (this.players.size >= MAX_PLAYERS) return refuse(`the server is full (${MAX_PLAYERS} players)`);
    const record = this.records.get(token);
    const avatar = normalizeAvatarId(hello.avatar) ?? record?.avatar ?? DEFAULT_AVATAR;
    const name = cleanName(hello.name, record?.name ?? avatarName(avatar));
    const [sx, sy, sz] = this.spawn;
    const pose = record?.pose ?? { x: sx, y: sy, z: sz, yaw: Math.PI, pitch: 0, flags: 0, vx: 0, vz: 0 };
    /** @type {ServerPlayer} */
    const player = { id: this._nextId++, token, name, avatar, socket, pose: { ...pose }, poseDirty: true, held: null };
    this.players.set(player.id, player);
    this.records.set(token, { name, avatar, pose: { ...pose } });
    this.dirty = true;
    socket.send(encode({
      t: 'welcome',
      v: PROTOCOL_VERSION,
      id: player.id,
      token,
      world: { name: this.name, seed: this.seed, gen: this.gen, mode: this.mode, time: this.time, day: this.day },
      edits: this.world.exportEdits(),
      bricks: this.world.bricks.export(),
      spawn: this.spawn,
      you: { name, avatar, pose: player.pose },
      players: [...this.players.values()].filter((p) => p !== player)
        .map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, pose: p.pose, held: p.held })),
    }));
    this.broadcast({ t: 'join', id: player.id, name, avatar, pose: player.pose }, player);
    this.log(`${name} joined (${this.players.size} playing)`);
    return player;
  }

  /** @param {ServerPlayer} player @param {string} [why] */
  leave(player, why = 'left') {
    if (!this.players.delete(player.id)) return;
    this.records.set(player.token, { name: player.name, avatar: player.avatar, pose: { ...player.pose } });
    this.dirty = true;
    this.broadcast({ t: 'leave', id: player.id });
    if (why === 'replaced') player.socket.close(4001, REPLACED_REASON);
    this.log(`${player.name} ${why} (${this.players.size} playing)`);
  }

  /**
   * One message from a joined player. Malformed messages are ignored.
   * @param {ServerPlayer} player @param {any} msg
   */
  onMessage(player, msg) {
    if (!msg || !this.players.has(player.id)) return;
    switch (msg.t) {
      case 'pose': {
        const pose = cleanPose(msg);
        if (pose) {
          // a swing not yet broadcast survives a second pose in the same tick
          if (player.poseDirty && (player.pose.flags & POSE_SWING)) pose.flags |= POSE_SWING;
          player.pose = pose;
          player.poseDirty = true;
        }
        return;
      }
      case 'set': {
        const c = cleanCell(msg);
        if (c) this._setIntent(player, c);
        return;
      }
      case 'brick': {
        const b = cleanBrick(msg);
        if (b) this._brickIntent(player, b);
        return;
      }
      case 'held': { // §98: what is in the hand, for the others' view of this player
        const held = cleanHeld(msg.item);
        if (held !== player.held) {
          player.held = held;
          this.broadcast({ t: 'held', id: player.id, item: held }, player);
        }
        return;
      }
      case 'chat': {
        const text = cleanChat(msg.text);
        if (text) this.broadcast({ t: 'chat', from: player.name, text });
        return;
      }
      case 'ping':
        player.socket.send(encode({ t: 'pong', at: msg.at }));
        return;
      default:
    }
  }

  /** @returns {boolean} world point (x, y, z) is within reach of the player's eye (with slack for lag) */
  _inReach(player, x, y, z) {
    const p = player.pose;
    return Math.hypot(x - p.x, y - (p.y + 1.6), z - p.z) <= REACH + REACH_SLACK;
  }

  /**
   * A player puts a hex block (or AIR: breaks one). Creative rules: any block but a building material (those are only
   * ever bricks, §93.5), a brick's shadow and bedrock — a block's other states too (a door opened, a lever thrown); within
   * reach; in a loaded chunk. Applied as the player's (the physics attributes what follows to them). A refused or
   * unchanged intent tells that player the cell's true value.
   * @param {ServerPlayer} player @param {{ q: number, y: number, r: number, id: number }} c
   */
  _setIntent(player, c) {
    const { q, y, r, id } = c;
    const [x, z] = hexToWorld(q, r);
    const ok = this.world.hasChunkAtCell(q, r)
      && this._inReach(player, x, y + 0.5, z)
      && id < BLOCK_COUNT && !isBrickMaterial(id) && !isBrickShadow(id)
      && id !== BLOCK.BEDROCK
      && this.world.getBlock(q, y, r) !== BLOCK.BEDROCK
      && this.physics.asPlayer(() => this.world.setBlock(q, y, r, id));
    if (ok) {
      this.dirty = true;
      return;
    }
    if (this.world.hasChunkAtCell(q, r)) player.socket.send(encode({ t: 'cells', c: [q, y, r, this.world.getBlock(q, y, r)] }));
  }

  /**
   * A player lays a brick (or AIR: takes one away). A building material only, where brickBlocker allows; within reach.
   * A refused intent tells that player the brick's true value.
   * @param {ServerPlayer} player @param {{ i: number, y: number, n: number, id: number }} b
   */
  _brickIntent(player, b) {
    const { i, y, n, id } = b;
    const world = this.world;
    const cur = world.bricks.getBlock(i, y, n);
    const near = this._inReach(player, i + 0.5, y + 0.5, (n + 0.5) * BRICK_DEPTH);
    let ok = false;
    if (near && id === BLOCK.AIR) ok = cur !== BLOCK.AIR && this.physics.asPlayer(() => world.setBrick(i, y, n, BLOCK.AIR));
    else if (near && isBrickMaterial(id) && world.brickBlocker(i, y, n) === null) ok = this.physics.asPlayer(() => world.setBrick(i, y, n, id));
    if (ok) {
      this._bricks.push(i, y, n, id);
      this.dirty = true;
      return;
    }
    player.socket.send(encode({ t: 'bricks', b: [i, y, n, world.bricks.getBlock(i, y, n)] }));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // the tick

  /**
   * One server tick (TICK_S): stream the world round every player, run the block physics, advance the clock, then
   * broadcast what changed — bricks before cells (a cell's shadow follows its bricks), the poses of the players who moved,
   * and the clock every TIME_SYNC_S.
   * @param {number} [dt]
   */
  tick(dt = TICK_S) {
    const centres = [...this.players.values()].map((p) => [p.pose.x, p.pose.z]);
    if (centres.length > 0) {
      this.world.updateCentres(centres, GEN_BUDGET_MS);
      this.physics.step(dt);
      const nt = advanceTime(this.time, dt);
      if (nt < this.time) this.day++;
      this.time = nt;
    }
    if (this._bricks.length > 0) {
      this.broadcast({ t: 'bricks', b: this._bricks });
      this._bricks = [];
    }
    if (this._cells.size > 0) {
      const flat = [];
      for (const c of this._cells.values()) flat.push(c[0], c[1], c[2], c[3]);
      this._cells.clear();
      this.dirty = true;
      this.broadcast({ t: 'cells', c: flat });
    }
    const moved = [...this.players.values()].filter((p) => p.poseDirty);
    if (moved.length > 0) {
      const all = moved.map((p) => packPose(p.id, p.pose));
      for (const p of this.players.values()) {
        const others = all.filter((a) => a[0] !== p.id);
        if (others.length > 0) p.socket.send(encode({ t: 'poses', p: others }));
      }
      for (const p of moved) {
        p.poseDirty = false;
        p.pose.flags &= ~POSE_SWING; // a swing is broadcast once
      }
    }
    this._timeSync += dt;
    if (this._timeSync >= TIME_SYNC_S && this.players.size > 0) {
      this._timeSync = 0;
      this.broadcast({ t: 'time', time: this.time, day: this.day });
    }
  }

  /** @param {object} msg @param {ServerPlayer|null} [except] */
  broadcast(msg, except = null) {
    const text = encode(msg);
    for (const p of this.players.values()) if (p !== except) p.socket.send(text);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // saving

  /**
   * The world as the server saves it: its own small document (seed, generation, clock, edits — the physics' transient
   * motion settled as single-player saves settle it — bricks, the physics switches, and each player's name, avatar and
   * last pose by token).
   */
  toJSON() {
    for (const p of this.players.values()) this.records.set(p.token, { name: p.name, avatar: p.avatar, pose: { ...p.pose } });
    return {
      format: SERVER_SAVE_FORMAT,
      v: SERVER_SAVE_VERSION,
      name: this.name,
      seed: this.seed,
      gen: this.gen,
      mode: this.mode,
      time: this.time,
      day: this.day,
      edits: this.physics.exportEdits(),
      bricks: this.world.bricks.export(),
      physics: this.physics.exportSwitches(),
      players: Object.fromEntries(this.records),
    };
  }
}

/** @param {string} avatar @returns {string} the avatar's display name ("Caelan") */
function avatarName(avatar) {
  return AVATAR_IDS.includes(avatar) ? avatar.charAt(0).toUpperCase() + avatar.slice(1) : 'Player';
}

/** For log lines and tests: a block's name. */
export function blockName(id) {
  return getBlockDef(id).name;
}
