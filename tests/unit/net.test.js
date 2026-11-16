// src/net.js — the multiplayer client (docs/DESIGN-multiplayer.md §2–§3): the connection with a fake WebSocket, the other
// players' interpolated poses, the server probe and the browser's token.
import { describe, it, expect } from 'vitest';
import {
  NetClient, RemotePlayers, REMOTE_DELAY_S, TOKEN_KEY, serverWsUrl, probeServer, playerToken,
} from '../../src/net.js';
import { PROTOCOL_VERSION, POSE_SWING, encode, decode } from '../../src/protocol.js';

/** A WebSocket stand-in: records what is sent; the test opens it and delivers messages. */
class FakeWS {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    /** @type {any[]} */
    this.sent = [];
    this.closedWith = null;
    FakeWS.last = this;
  }

  send(text) {
    this.sent.push(decode(text));
  }

  close(code, reason) {
    this.closedWith = { code, reason };
    this.readyState = 3;
    if (this.onclose) this.onclose({ code, reason });
  }

  open() {
    this.readyState = 1;
    this.onopen();
  }

  deliver(msg) {
    this.onmessage({ data: encode(msg) });
  }

  drop(reason = '') {
    this.readyState = 3;
    this.onclose({ code: 1006, reason });
  }
}
/** @type {FakeWS|null} */
FakeWS.last = null;

const client = () => new NetClient({ url: 'ws://pc:4180/ws', WebSocketImpl: FakeWS, name: 'Dad', avatar: 'caelan', token: 'abcdefgh-1' });
const drained = (c) => {
  const out = [];
  c.drain((m) => out.push(m));
  return out;
};
const pose = (x, yaw = 0, flags = 0) => ({ x, y: 70, z: 0, yaw, pitch: 0, flags, vx: 0, vz: 0 });

describe('serverWsUrl / probeServer', () => {
  it('the WebSocket of the server that served the page, or of ?server=', () => {
    expect(serverWsUrl({ protocol: 'http:', host: '192.168.1.5:4180' })).toBe('ws://192.168.1.5:4180/ws');
    expect(serverWsUrl({ protocol: 'https:', host: 'game.example' })).toBe('wss://game.example/ws');
    expect(serverWsUrl({ protocol: 'http:', host: 'localhost:5173' }, '10.0.0.2:4180')).toBe('ws://10.0.0.2:4180/ws');
    expect(serverWsUrl({ protocol: 'http:', host: 'localhost:5173' }, 'evil/path?x')).toBe('ws://localhost:5173/ws');
  });

  const loc = { protocol: 'http:', host: 'pc:4180' };
  const reply = (body, ok = true) => async (url) => {
    reply.url = url;
    return { ok, json: async () => (typeof body === 'function' ? body() : body) };
  };

  it('reads what the server says about itself', async () => {
    const f = reply({ name: 'home', version: PROTOCOL_VERSION, players: 2, mode: 'creative' });
    expect(await probeServer(f, loc)).toEqual({ name: 'home', version: PROTOCOL_VERSION, players: 2, mode: 'creative', mismatch: undefined });
    expect(reply.url).toBe('http://pc:4180/api/info');
    await probeServer(f, loc, '10.0.0.2:4180');
    expect(reply.url).toBe('http://10.0.0.2:4180/api/info');
  });

  it('flags another protocol version', async () => {
    const info = await probeServer(reply({ name: 'x', version: PROTOCOL_VERSION + 1, players: 0, mode: 'survival' }), loc);
    expect(info.mismatch).toBe(true);
    expect(info.mode).toBe('survival');
  });

  it('is null where there is no game server', async () => {
    expect(await probeServer(reply({}, false), loc)).toBeNull();
    expect(await probeServer(reply({ hello: 1 }), loc)).toBeNull();
    expect(await probeServer(reply(() => {
      throw new SyntaxError('not JSON');
    }), loc)).toBeNull();
    expect(await probeServer(async () => {
      throw new TypeError('network');
    }, loc)).toBeNull();
  });
});

describe('playerToken', () => {
  const store = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), m };
  };

  it('is made once and kept', () => {
    const s = store();
    const t = playerToken(s);
    expect(t).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{8}){3}$/);
    expect(s.m.get(TOKEN_KEY)).toBe(t);
    expect(playerToken(s)).toBe(t);
  });

  it('replaces a bad stored token, and works without storage', () => {
    const s = store();
    s.setItem(TOKEN_KEY, 'no!');
    expect(playerToken(s)).not.toBe('no!');
    expect(playerToken(null)).toMatch(/^[0-9a-f-]{35}$/);
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(playerToken(broken)).toMatch(/^[0-9a-f-]{35}$/);
  });
});

describe('NetClient', () => {
  it('says hello when the socket opens', () => {
    const c = client();
    c.connect();
    expect(c.state).toBe('connecting');
    const ws = FakeWS.last;
    expect(ws.url).toBe('ws://pc:4180/ws');
    ws.open();
    expect(c.state).toBe('open');
    expect(ws.sent).toEqual([{ t: 'hello', v: PROTOCOL_VERSION, name: 'Dad', avatar: 'caelan', token: 'abcdefgh-1' }]);
  });

  it('joins on the welcome and queues every message, oldest first', () => {
    const c = client();
    c.connect();
    const ws = FakeWS.last;
    ws.open();
    c.sendSet(1, 2, 3, 4); // not joined yet: dropped
    expect(ws.sent).toHaveLength(1);
    ws.deliver({ t: 'welcome', id: 3 });
    ws.deliver({ t: 'cells', c: [1, 2, 3, 4] });
    ws.onmessage({ data: 'garbage' });
    expect(c.state).toBe('joined');
    expect(c.id).toBe(3);
    expect(drained(c).map((m) => m.t)).toEqual(['welcome', 'cells']);
    expect(drained(c)).toEqual([]);
  });

  it('sends the pose and the intents once joined', () => {
    const c = client();
    c.connect();
    const ws = FakeWS.last;
    ws.open();
    ws.deliver({ t: 'welcome', id: 1 });
    c.sendPose(pose(1));
    c.sendSet(1, 60, 2, 0);
    c.sendBrick(4, 61, 5, 9);
    c.sendChat('  hello  ');
    c.sendChat('   '); // nothing to say
    expect(ws.sent.slice(1)).toEqual([
      { t: 'pose', ...pose(1) },
      { t: 'set', q: 1, y: 60, r: 2, id: 0 },
      { t: 'brick', i: 4, y: 61, n: 5, id: 9 },
      { t: 'chat', text: 'hello' },
    ]);
  });

  it('a refusal is the reason the connection closed', () => {
    const c = client();
    c.connect();
    const ws = FakeWS.last;
    ws.open();
    ws.deliver({ t: 'refused', reason: 'the server is full (8 players)' });
    ws.drop('whatever');
    expect(c.state).toBe('closed');
    expect(drained(c).at(-1)).toEqual({ t: 'closed', reason: 'the server is full (8 players)' });
  });

  it('a server that never answered, and one that went away', () => {
    const a = client();
    a.connect();
    FakeWS.last.drop();
    expect(drained(a).at(-1)).toEqual({ t: 'closed', reason: 'could not reach the server' });
    const b = client();
    b.connect();
    const ws = FakeWS.last;
    ws.open();
    ws.deliver({ t: 'welcome', id: 1 });
    ws.drop();
    expect(drained(b).at(-1)).toEqual({ t: 'closed', reason: 'the server closed the connection' });
  });

  it('closing it ourselves queues nothing more', () => {
    const c = client();
    c.connect();
    const ws = FakeWS.last;
    ws.open();
    ws.deliver({ t: 'welcome', id: 1 });
    drained(c);
    c.close();
    expect(ws.closedWith).toEqual({ code: 1000, reason: 'left' });
    expect(c.state).toBe('closed');
    expect(drained(c)).toEqual([]);
  });

  it('a constructor that throws closes at once', () => {
    const c = new NetClient({ url: 'x', WebSocketImpl: function Bad() { throw new Error('bad url'); }, name: '', avatar: '', token: 'abcdefgh' });
    c.connect();
    expect(c.state).toBe('closed');
    expect(drained(c)[0].reason).toMatch(/bad url/);
  });
});

describe('RemotePlayers', () => {
  it('draws a player a little in the past, between the poses round that moment', () => {
    const rp = new RemotePlayers();
    rp.join({ id: 2, name: 'Brayden', avatar: 'brayden', pose: pose(0) }, 0);
    rp.push(2, pose(10), 1);
    expect(rp.sample(2, 0.5 + REMOTE_DELAY_S).x).toBeCloseTo(5);
    expect(rp.sample(2, 0).x).toBe(0); // before them all: the oldest
    expect(rp.sample(2, 5).x).toBe(10); // past them all: the newest
    expect(rp.sample(9, 1)).toBeNull();
  });

  it('turns the short way round', () => {
    const rp = new RemotePlayers();
    rp.join({ id: 1, name: 'A', avatar: 'caelan', pose: pose(0, 2 * Math.PI - 0.2) }, 0);
    rp.push(1, pose(0, 0.2), 1);
    const yaw = rp.sample(1, 0.5 + REMOTE_DELAY_S).yaw;
    expect(Math.abs(Math.sin(yaw))).toBeLessThan(1e-9); // through 0, not through π
    expect(Math.cos(yaw)).toBeCloseTo(1);
  });

  it('keeps a short buffer, counts swings, forgets a player who left', () => {
    const rp = new RemotePlayers();
    rp.join({ id: 1, name: '<Annabelle>', avatar: 'annabelle', pose: null }, 0);
    expect(rp.sample(1, 1)).toBeNull();
    for (let k = 0; k < 40; k++) rp.push(1, pose(k, 0, k % 10 === 0 ? POSE_SWING : 0), k);
    const p = rp.list()[0];
    expect(p.name).toBe('Annabelle');
    expect(p.buffer.length).toBeLessThanOrEqual(12);
    expect(p.swings).toBe(4);
    rp.push(1, { x: NaN }, 41); // a bad pose is ignored
    expect(rp.sample(1, 100).x).toBe(39);
    rp.leave(1);
    expect(rp.list()).toEqual([]);
  });
});
