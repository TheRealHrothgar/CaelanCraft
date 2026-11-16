// server/index.js end to end (docs/DESIGN-multiplayer.md §2): the real HTTP server and WebSocket on a free port, two real
// clients (the browser's NetClient over `ws`), the game files, /api/info, an intent seen by both, and the save on stop.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { start, parseArgs } from '../../server/index.js';
import { NetClient, serverWsUrl, probeServer } from '../../src/net.js';
import { PROTOCOL_VERSION, DEFAULT_PORT, unflatten4 } from '../../src/protocol.js';
import { BLOCK } from '../../src/blocks.js';
import { worldToHex } from '../../src/hex.js';

/** Wait until `pred()` is true (polling), or fail after `ms`. */
async function until(pred, ms = 8000, what = 'condition') {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A NetClient whose inbox is collected into `got`. */
function joinAs(url, name, token) {
  const c = new NetClient({ url, WebSocketImpl: WebSocket, name, avatar: 'caelan', token });
  /** @type {any[]} */
  const got = [];
  c.connect();
  const timer = setInterval(() => c.drain((m) => got.push(m)), 10);
  return { c, got, stop: () => clearInterval(timer), of: (t) => got.filter((m) => m.t === t) };
}

describe('parseArgs', () => {
  it('reads the options, with the defaults', () => {
    const o = parseArgs([]);
    expect(o.port).toBe(DEFAULT_PORT);
    expect(o.world).toBe('home');
    const p = parseArgs(['--port', '5000', '--world', 'boys_world', '--seed', '42', '--host', '127.0.0.1']);
    expect(p).toMatchObject({ port: 5000, world: 'boys_world', seed: 42, host: '127.0.0.1' });
    expect(parseArgs(['--seed', 'hello']).seed).toBe('hello');
  });

  it('refuses a bad port or world name', () => {
    expect(() => parseArgs(['--port', '0'])).toThrow(/port/);
    expect(() => parseArgs(['--world', '../etc'])).toThrow(/world/);
  });
});

describe('the server, end to end', () => {
  let tmp;
  /** @type {ReturnType<typeof start>} */
  let srv;
  let base;
  let wsUrl;
  const lines = [];

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caelancraft-server-'));
    const client = path.join(tmp, 'dist');
    fs.mkdirSync(path.join(client, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(client, 'index.html'), '<!doctype html><title>Caelancraft</title>');
    fs.writeFileSync(path.join(client, 'assets', 'game.js'), 'export {};');
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'outside');
    srv = start({ port: 0, host: '127.0.0.1', world: 'test', seed: 777, client, worlds: path.join(tmp, 'worlds'), log: (l) => lines.push(l) });
    await new Promise((r) => (srv.server.listening ? r() : srv.server.once('listening', r)));
    const { port } = /** @type {import('node:net').AddressInfo} */ (srv.server.address());
    base = `http://127.0.0.1:${port}`;
    wsUrl = serverWsUrl({ protocol: 'http:', host: `127.0.0.1:${port}` });
  });

  afterAll(() => {
    if (srv && srv.server.listening) srv.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('serves the game files, never anything outside them', async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(page.headers.get('cache-control')).toBe('no-cache');
    expect(await page.text()).toMatch(/Caelancraft/);
    const js = await fetch(`${base}/assets/game.js`);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    expect((await fetch(`${base}/nope.js`)).status).toBe(404);
    expect((await fetch(`${base}/..%2Fsecret.txt`)).status).toBe(403);
  });

  it('says what it is at /api/info, to any page', async () => {
    const res = await fetch(`${base}/api/info`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual({ name: 'test', version: PROTOCOL_VERSION, players: 0, mode: 'creative' });
    const loc = new URL(base);
    expect(await probeServer(fetch, { protocol: loc.protocol, host: loc.host })).toMatchObject({ name: 'test', players: 0 });
  });

  it('two players join, and a block one places reaches both', async () => {
    const dad = joinAs(wsUrl, 'Dad', 'token-dad-0001');
    await until(() => dad.c.state === 'joined', 8000, 'Dad joined');
    const son = joinAs(wsUrl, 'Caelan', 'token-son-0002');
    await until(() => son.c.state === 'joined', 8000, 'Caelan joined');
    try {
      const welcome = dad.of('welcome')[0];
      expect(welcome.world.seed).toBe(777);
      await until(() => dad.of('join').length === 1, 4000, 'the join');
      expect(dad.of('join')[0].name).toBe('Caelan');
      const [sx, sy, sz] = welcome.spawn;
      const [q, r] = worldToHex(sx, sz);
      await until(() => srv.game.world.hasChunkAtCell(q, r), 8000, 'the spawn chunk');
      let y = Math.floor(sy) + 1;
      while (srv.game.world.getBlock(q, y, r) !== BLOCK.AIR) y++;
      dad.c.sendSet(q, y, r, BLOCK.STONE); // (glass is a building material: bricks only)
      const seen = (p) => p.of('cells').some((m) => unflatten4(m.c).some((c) => c[0] === q && c[1] === y && c[2] === r && c[3] === BLOCK.STONE));
      await until(() => seen(dad) && seen(son), 4000, 'the cell at both');
      dad.c.sendPose({ x: sx + 1, y: sy, z: sz, yaw: 0, pitch: 0, flags: 0, vx: 0, vz: 0 });
      await until(() => son.of('poses').length > 0, 4000, 'the pose');
      expect(son.of('poses').at(-1).p[0][0]).toBe(welcome.id);
      son.c.sendChat('hello dad');
      await until(() => dad.of('chat').length > 0, 4000, 'the chat');
      expect(dad.of('chat')[0]).toEqual({ t: 'chat', from: 'Caelan', text: 'hello dad' });
      expect((await (await fetch(`${base}/api/info`)).json()).players).toBe(2);
      son.c.close();
      await until(() => dad.of('leave').length === 1, 4000, 'the leave');
    } finally {
      dad.c.close();
      son.c.close();
      dad.stop();
      son.stop();
    }
  });

  it('saves the world on stop', async () => {
    srv.stop();
    await new Promise((r) => setTimeout(r, 50));
    const save = JSON.parse(fs.readFileSync(srv.saveFile, 'utf8'));
    expect(save.format).toBe('caelancraft-server-world');
    expect(save.seed).toBe(777);
    expect(Object.keys(save.players).sort()).toEqual(['token-dad-0001', 'token-son-0002']);
    expect(lines.some((l) => /saved \(shutting down\)/.test(l))).toBe(true);
  });
});
