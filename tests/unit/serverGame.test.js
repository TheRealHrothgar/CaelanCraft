// server/game.js — the multiplayer server's game (docs/DESIGN-multiplayer.md §2–§4, phase 1), driven with fake sockets:
// joining, the intents and their checks, the broadcasts, the poses, the clock and the save. One world for the file (its
// chunks take a while to generate); the steps build on each other.
import { describe, it, expect, beforeAll } from 'vitest';
import { ServerGame, SERVER_SAVE_FORMAT, SIM_RADIUS } from '../../server/game.js';
import { PROTOCOL_VERSION, POSE_SWING, MAX_PLAYERS, decode, unflatten4 } from '../../src/protocol.js';
import { BLOCK, BRICK_MATERIAL_IDS } from '../../src/blocks.js';
import { worldToHex, hexToWorld } from '../../src/hex.js';
import { BRICK_DEPTH } from '../../src/bricks.js';
import { World } from '../../src/world.js';
import { CHUNK_SIZE } from '../../src/config.js';

function fakeSocket() {
  const s = {
    /** @type {any[]} */
    sent: [],
    closed: null,
    send(text) {
      s.sent.push(decode(text));
    },
    close(code, reason) {
      s.closed = { code, reason };
    },
    /** @param {string} t */
    of: (t) => s.sent.filter((m) => m.t === t),
    clear() {
      s.sent.length = 0;
    },
  };
  return s;
}
const hello = (extra = {}) => ({ t: 'hello', v: PROTOCOL_VERSION, name: 'Dad', avatar: 'caelan', token: 'token-aaaa-1', ...extra });
/** every [a, y, b, id] the socket was sent in `t` messages (`cells` / `bricks`) */
const quads = (s, t) => s.of(t).flatMap((m) => unflatten4(m.c ?? m.b));

describe('ServerGame (phase 1)', () => {
  /** @type {ServerGame} */
  let game;
  let a;
  let b;
  /** @type {any} */
  let pa;
  /** @type {any} */
  let pb;
  let cell;

  beforeAll(() => {
    game = new ServerGame({ name: 'test', seed: 4242 });
    // the spawn's chunk, generated before the first player (a tick with players streams the rest)
    const [sx, , sz] = game.spawn;
    game.world.updateCentres([[sx, sz]], 1e9);
  });

  it('says what it is', () => {
    expect(game.info()).toEqual({ name: 'test', version: PROTOCOL_VERSION, players: 0, mode: 'creative' });
  });

  it('refuses another version and a bad first message', () => {
    const s = fakeSocket();
    expect(game.join(s, hello({ v: PROTOCOL_VERSION + 1 }))).toBeNull();
    expect(s.sent[0].t).toBe('refused');
    expect(s.sent[0].reason).toMatch(/version/);
    expect(s.closed.code).toBe(4000);
    const s2 = fakeSocket();
    expect(game.join(s2, { t: 'pose' })).toBeNull();
    expect(s2.sent[0]).toEqual({ t: 'refused', reason: 'expected hello' });
    expect(game.players.size).toBe(0);
  });

  it('welcomes a player with the world to build (seed, generation, edits, bricks) at the spawn', () => {
    a = fakeSocket();
    pa = game.join(a, hello());
    expect(pa.id).toBe(1);
    const w = a.sent[0];
    expect(w.t).toBe('welcome');
    expect(w.v).toBe(PROTOCOL_VERSION);
    expect(w.world).toMatchObject({ name: 'test', seed: game.seed, gen: game.gen, mode: 'creative' });
    expect(typeof w.edits).toBe('object');
    expect(w.spawn).toEqual(game.spawn);
    expect(w.you.name).toBe('Dad');
    expect(w.you.pose).toMatchObject({ x: game.spawn[0], y: game.spawn[1], z: game.spawn[2] });
    expect(w.players).toEqual([]);
    expect(game.info().players).toBe(1);
  });

  it('tells the others who joined, and the newcomer who is there', () => {
    b = fakeSocket();
    pb = game.join(b, hello({ name: '  Brayden<script>  ', avatar: 'brayden', token: 'token-bbbb-2' }));
    expect(pb.name).toBe('Braydenscript');
    expect(b.sent[0].players.map((p) => p.id)).toEqual([pa.id]);
    expect(a.of('join')).toEqual([{ t: 'join', id: pb.id, name: pb.name, avatar: 'brayden', pose: pb.pose }]);
  });

  it('a nameless player is named after their avatar', () => {
    const s = fakeSocket();
    const p = game.join(s, hello({ name: '', avatar: 'annabelle', token: 'token-cccc-3' }));
    expect(p.name).toBe('Annabelle');
    game.leave(p);
    expect(a.of('leave').at(-1)).toEqual({ t: 'leave', id: p.id });
  });

  it('streams the world round the players', () => {
    game.tick();
    const [q, r] = worldToHex(game.spawn[0], game.spawn[2]);
    expect(game.world.hasChunkAtCell(q, r)).toBe(true);
    expect(game.world.renderDistance).toBe(SIM_RADIUS);
  });

  it('applies a hex intent within reach and broadcasts the cell to everyone', () => {
    a.clear();
    b.clear();
    const [sx, sy, sz] = game.spawn;
    const [q, r] = worldToHex(sx + 1.6, sz);
    let y = Math.floor(sy);
    while (game.world.getBlock(q, y, r) !== BLOCK.AIR) y++;
    cell = [q, y, r];
    game.onMessage(pa, { t: 'set', q, y, r, id: BLOCK.STONE });
    expect(game.world.getBlock(q, y, r)).toBe(BLOCK.STONE);
    game.tick();
    for (const s of [a, b]) expect(quads(s, 'cells')).toContainEqual([q, y, r, BLOCK.STONE]);
    expect(game.dirty).toBe(true);
  });

  it('refuses a building material, bedrock and a brick shadow as a hex, answering with the true cell', () => {
    const [q, y, r] = cell;
    for (const id of [BRICK_MATERIAL_IDS[0], BLOCK.BEDROCK, BLOCK.BRICK_SHADOW]) {
      a.clear();
      game.onMessage(pa, { t: 'set', q, y: y + 1, r, id });
      expect(a.of('cells')).toEqual([{ t: 'cells', c: [q, y + 1, r, game.world.getBlock(q, y + 1, r)] }]);
      expect(game.world.getBlock(q, y + 1, r)).not.toBe(id);
    }
  });

  it('accepts a block’s other states (Creative)', () => {
    const [q, y, r] = cell;
    game.onMessage(pa, { t: 'set', q, y, r, id: BLOCK.AIR });
    expect(game.world.getBlock(q, y, r)).toBe(BLOCK.AIR);
    game.onMessage(pa, { t: 'set', q, y, r, id: BLOCK.STONE });
    expect(game.world.getBlock(q, y, r)).toBe(BLOCK.STONE);
  });

  it('refuses an intent out of reach', () => {
    const [q, y, r] = cell;
    const far = { ...pa.pose, x: pa.pose.x + 30 };
    game.onMessage(pb, { t: 'pose', ...far });
    b.clear();
    game.onMessage(pb, { t: 'set', q, y, r, id: BLOCK.AIR });
    expect(game.world.getBlock(q, y, r)).toBe(BLOCK.STONE);
    expect(b.of('cells')).toEqual([{ t: 'cells', c: [q, y, r, BLOCK.STONE] }]);
    game.onMessage(pb, { t: 'pose', ...pa.pose }); // back
  });

  it('lays a brick of a building material where nothing is in the way, and broadcasts it', () => {
    const [sx, sy, sz] = game.spawn;
    const i = Math.floor(sx) - 2;
    const n = Math.floor(sz / BRICK_DEPTH);
    let y = Math.floor(sy);
    while (game.world.brickBlocker(i, y, n) !== null && y < sy + 4) y++;
    expect(game.world.brickBlocker(i, y, n)).toBeNull();
    const id = BRICK_MATERIAL_IDS[0];
    a.clear();
    b.clear();
    game.onMessage(pa, { t: 'brick', i, y, n, id: BLOCK.STONE }); // not a building material: refused
    expect(a.of('bricks')).toEqual([{ t: 'bricks', b: [i, y, n, BLOCK.AIR] }]);
    game.onMessage(pa, { t: 'brick', i, y, n, id });
    expect(game.world.bricks.getBlock(i, y, n)).toBe(id);
    game.onMessage(pa, { t: 'brick', i, y, n, id }); // taken: refused, answered with the brick there
    game.tick();
    for (const s of [a, b]) expect(quads(s, 'bricks')).toContainEqual([i, y, n, id]);
    expect(quads(b, 'bricks').filter((x) => x[0] === i && x[2] === n && x[1] === y)).toHaveLength(1);
    game.onMessage(pb, { t: 'brick', i, y, n, id: BLOCK.AIR }); // taken away
    expect(game.world.bricks.getBlock(i, y, n)).toBe(BLOCK.AIR);
  });

  it('sends each player the others’ poses, a swing once even when a newer pose came in the same tick', () => {
    game.tick();
    a.clear();
    b.clear();
    const p = { ...pa.pose, x: pa.pose.x + 0.5 };
    game.onMessage(pa, { t: 'pose', ...p, flags: POSE_SWING });
    game.onMessage(pa, { t: 'pose', ...p, x: p.x + 0.1, flags: 0 });
    game.tick();
    expect(a.of('poses')).toEqual([]);
    const got = b.of('poses');
    expect(got).toHaveLength(1);
    expect(got[0].p).toHaveLength(1);
    expect(got[0].p[0][0]).toBe(pa.id);
    expect(got[0].p[0][1]).toBeCloseTo(p.x + 0.1);
    expect(got[0].p[0][6] & POSE_SWING).toBe(POSE_SWING);
    b.clear();
    game.onMessage(pa, { t: 'pose', ...p, flags: 0 });
    game.tick();
    expect(b.of('poses')[0].p[0][6] & POSE_SWING).toBe(0);
    game.tick();
    expect(b.of('poses')).toHaveLength(1); // nobody moved: nothing more
  });

  it('passes chat on to everyone with the speaker’s name, and answers a ping', () => {
    a.clear();
    b.clear();
    game.onMessage(pb, { t: 'chat', text: '  hi dad\n' });
    game.onMessage(pb, { t: 'chat', text: '   ' });
    for (const s of [a, b]) expect(s.of('chat')).toEqual([{ t: 'chat', from: pb.name, text: 'hi dad' }]);
    game.onMessage(pa, { t: 'ping', at: 12 });
    expect(a.of('pong')).toEqual([{ t: 'pong', at: 12 }]);
  });

  it('ignores malformed messages', () => {
    const before = game.world.editVersion;
    for (const m of [null, { t: 'set', q: 'x' }, { t: 'brick' }, { t: 'pose', x: NaN }, { t: 'unknown' }]) game.onMessage(pa, m);
    expect(game.world.editVersion).toBe(before);
  });

  it('sends the clock every few seconds', () => {
    a.clear();
    game.tick(5);
    const t = a.of('time');
    expect(t).toHaveLength(1);
    expect(t[0].time).toBeCloseTo(game.time);
    expect(t[0].day).toBe(game.day);
  });

  it('the same browser again replaces its old connection', () => {
    const again = fakeSocket();
    const p = game.join(again, hello());
    expect(a.closed.code).toBe(4001);
    expect(game.players.size).toBe(2);
    expect(again.sent[0].you.pose.x).toBeCloseTo(pa.pose.x);
    pa = p;
    a = again;
  });

  it('is full at MAX_PLAYERS', () => {
    const extra = [];
    for (let k = game.players.size; k < MAX_PLAYERS; k++) extra.push(game.join(fakeSocket(), hello({ token: `token-extra-${k}` })));
    const s = fakeSocket();
    expect(game.join(s, hello({ token: 'token-one-too-many' }))).toBeNull();
    expect(s.sent[0].reason).toMatch(/full/);
    for (const p of extra) game.leave(p);
  });

  it('saves the world and its players, and starts again from the save', () => {
    const [q, y, r] = cell;
    game.leave(pb);
    const save = JSON.parse(JSON.stringify(game.toJSON()));
    expect(save.format).toBe(SERVER_SAVE_FORMAT);
    expect(save.seed).toBe(game.seed);
    expect(Object.keys(save.players)).toEqual(expect.arrayContaining(['token-aaaa-1', 'token-bbbb-2', 'token-cccc-3']));
    const again = new ServerGame({ save });
    expect(again.seed).toBe(game.seed);
    expect(again.name).toBe('test');
    const [x, z] = hexToWorld(q, r);
    again.world.updateCentres([[x, z]], 1e9);
    expect(again.world.getBlock(q, y, r)).toBe(BLOCK.STONE);
    const s = fakeSocket();
    const p = again.join(s, hello({ token: 'token-bbbb-2', name: '' }));
    expect(p.name).toBe(pb.name); // the record's name when the hello has none
    expect(p.pose.x).toBeCloseTo(pb.pose.x);
  });
});

describe('World multiplayer helpers', () => {
  it('applyServerCell sets a loaded cell and keeps one for a chunk not generated yet', () => {
    const w = new World({ seed: 7, renderDistance: 1, mesh: false });
    w.updateCentres([[0, 0]], 1e9);
    let y = 120;
    expect(w.applyServerCell(0, y, 0, BLOCK.STONE)).toBe(true);
    expect(w.getBlock(0, y, 0)).toBe(BLOCK.STONE);
    const far = CHUNK_SIZE * 40;
    expect(w.hasChunkAtCell(far, 0)).toBe(false);
    expect(w.applyServerCell(far, y, 0, BLOCK.GLASS)).toBe(false);
    const [x, z] = hexToWorld(far, 0);
    w.updateCentres([[x, z]], 1e9);
    expect(w.getBlock(far, y, 0)).toBe(BLOCK.GLASS);
    y = -1;
    expect(w.applyServerCell(far, y, 0, BLOCK.GLASS)).toBe(false);
  });

  it('updateCentres keeps a chunk loaded while any centre is near it', () => {
    const w = new World({ seed: 7, renderDistance: 1, mesh: false });
    const [fx, fz] = hexToWorld(CHUNK_SIZE * 30, 0);
    w.updateCentres([[0, 0], [fx, fz]], 1e9);
    expect(w.hasChunkAtCell(0, 0)).toBe(true);
    expect(w.hasChunkAtCell(CHUNK_SIZE * 30, 0)).toBe(true);
    w.updateCentres([[fx, fz]], 1e9);
    expect(w.hasChunkAtCell(0, 0)).toBe(false);
    expect(w.hasChunkAtCell(CHUNK_SIZE * 30, 0)).toBe(true);
    expect([...w.chunks.values()].every((c) => !c.meshed)).toBe(true);
  });
});
