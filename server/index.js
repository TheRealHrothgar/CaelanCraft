#!/usr/bin/env node
// Caelancraft — the multiplayer server (docs/DESIGN-multiplayer.md). One port serves the built game (dist/) and the
// WebSocket (/ws); the world is saved to <worlds>/<name>/world.json every 30 s while something changed, on Ctrl+C, and
// copied to backups/ every 30 minutes (the newest 10 kept).
//
//   node server/index.js [--port 4180] [--world home] [--seed 42] [--client dist] [--worlds server/worlds] [--host 0.0.0.0]
//
// Every device on the home network opens http://<this PC>:<port>/ and presses "Join".
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { ServerGame, TICK_S } from './game.js';
import { DEFAULT_PORT, WS_PATH, INFO_PATH, MAX_CLIENT_MESSAGE, decode } from '../src/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAVE_EVERY_S = 30;
const BACKUP_EVERY_S = 30 * 60;
const BACKUPS_KEPT = 10;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json; charset=utf-8', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, host: '0.0.0.0', world: 'home', seed: undefined, client: path.join(ROOT, 'dist'), worlds: path.join(ROOT, 'server', 'worlds') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--port') out.port = Number(v);
    else if (a === '--host') out.host = v;
    else if (a === '--world') out.world = v;
    else if (a === '--seed') out.seed = /^-?\d+$/.test(v) ? Number(v) : v;
    else if (a === '--client') out.client = path.resolve(v);
    else if (a === '--worlds') out.worlds = path.resolve(v);
    else continue;
    i++;
  }
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) throw new Error('--port must be 1..65535');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(out.world)) throw new Error('--world: letters, digits, _ and - only');
  return out;
}

/** Write `text` to `file` safely: a temporary file beside it, then a rename (a crash never leaves half a save). */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** @returns {string[]} http://<address>:<port>/ for every IPv4 address of this machine (the LAN ones first) */
function addresses(port) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}/`);
  }
  return out;
}

/**
 * Serve a file of the built game, never outside `root`; the page itself is never cached (a new build shows at once).
 * @param {string} root @param {http.IncomingMessage} req @param {http.ServerResponse} res
 */
function serveStatic(root, req, res) {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(root, `.${rel}`);
  if (!file.startsWith(root + path.sep) && file !== root) {
    res.writeHead(403).end();
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end(fs.existsSync(path.join(root, 'index.html'))
        ? 'not found' : `The game is not built: run "npm run build" (expected ${root}).`);
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': ext === '.html' || ext === '.webmanifest' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    fs.createReadStream(file).pipe(res);
  });
}

export function start(opts) {
  const log = opts.log ?? ((line) => console.log(`${new Date().toLocaleTimeString()}  ${line}`));
  const worldDir = path.join(opts.worlds, opts.world);
  const saveFile = path.join(worldDir, 'world.json');
  let save = null;
  if (fs.existsSync(saveFile)) {
    save = JSON.parse(fs.readFileSync(saveFile, 'utf8'));
    log(`loaded world "${opts.world}" from ${saveFile}`);
  }
  const game = new ServerGame({ name: opts.world, seed: opts.seed, save, log });
  if (!save) log(`new world "${opts.world}", seed ${game.seed}`);

  const doSave = (why) => {
    writeAtomic(saveFile, JSON.stringify(game.toJSON()));
    game.dirty = false;
    if (why) log(`saved (${why})`);
  };
  const backup = () => {
    if (!fs.existsSync(saveFile)) return;
    const dir = path.join(worldDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(saveFile, path.join(dir, `world-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
    const old = fs.readdirSync(dir).filter((f) => f.startsWith('world-')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - BACKUPS_KEPT))) fs.unlinkSync(path.join(dir, f));
  };
  if (!save) doSave('a new world');

  const server = http.createServer((req, res) => {
    if ((req.url || '').split('?')[0] === INFO_PATH) {
      // any page may ask (a client served from elsewhere — the Vite dev server — finds this server by ?server=)
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' })
        .end(JSON.stringify(game.info()));
      return;
    }
    serveStatic(opts.client, req, res);
  });
  const wss = new WebSocketServer({ server, path: WS_PATH, maxPayload: MAX_CLIENT_MESSAGE });
  wss.on('connection', (ws) => {
    /** @type {import('./game.js').ServerPlayer|null} */
    let player = null;
    const socket = {
      send: (text) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(text);
      },
      close: (code, reason) => ws.close(code, reason),
    };
    ws.on('message', (data) => {
      const msg = decode(String(data), MAX_CLIENT_MESSAGE);
      if (!msg) return;
      if (player === null) player = game.join(socket, msg);
      else game.onMessage(player, msg);
    });
    ws.on('close', () => {
      if (player) game.leave(player);
      player = null;
    });
    ws.on('error', () => {});
  });

  const tick = setInterval(() => {
    try {
      game.tick(TICK_S);
    } catch (e) {
      log(`tick failed: ${e && e.stack ? e.stack : e}`);
    }
  }, TICK_S * 1000);
  const saver = setInterval(() => {
    if (game.dirty) doSave('');
  }, SAVE_EVERY_S * 1000);
  const backer = setInterval(backup, BACKUP_EVERY_S * 1000);

  server.listen(opts.port, opts.host, () => {
    log(`Caelancraft server: world "${opts.world}", game files from ${opts.client}`);
    for (const a of addresses(opts.port)) log(`  open ${a}`);
    log(`  (this PC: http://localhost:${opts.port}/)`);
  });

  const stop = () => {
    clearInterval(tick);
    clearInterval(saver);
    clearInterval(backer);
    doSave('shutting down');
    for (const c of wss.clients) c.close(1001, 'the server is shutting down');
    server.close();
  };
  return { game, server, wss, stop, saveFile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = start(parseArgs(process.argv.slice(2)));
  const quit = () => {
    s.stop();
    process.exit(0);
  };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
}
