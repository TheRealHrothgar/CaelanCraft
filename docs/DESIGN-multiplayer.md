# Caelancraft — Multiplayer: one server, players on a PC and iPads (DRAFT v1, 2026-11-15)

## 1. What we are building

A dad hosts a world on his PC and plays it in his browser; his two sons join it from their iPads over the home Wi-Fi. Later
the same server program can run on a real host on the internet. Decisions taken with the user:

- **A separate server program** (Node.js): the PC runs one command; the host plays in a browser like everyone else. The
  same program can later run on a rented server.
- **Survival and Creative.** The world's mode is the host's; in Survival every player has their own pack, wear, health,
  hunger, thirst and sleep.
- **The world stays live round every player**, wherever each one is: chunks, water, fire, animals and zombies.
- **iPads play by touch.**

Single-player stays exactly as it is.

## 2. Architecture

```
  PC browser ─┐                       ┌─ world.json (+ backups)
  iPad ───────┼── ws://host:4180/ws ──┤  Node server: World, BlockPhysics, (phase 2) mobs, (phase 3) every player's survival
  iPad ───────┘   http://host:4180/   └─ serves the built client (dist/) on the same port
```

- **One port** serves the game (the built `dist/`) and the WebSocket (`/ws`). Every device opens the same address,
  `http://<pc>:4180/`; a page served by the server offers "Join this server" on its title screen.
- **The server is the truth.** It owns the world: seed, generation, edits, bricks, time, mode, block physics (water, sand,
  collapse, explosions), and from phase 2 the mobs, from phase 3 each player's survival state. It saves the world to disk
  (`server/worlds/<name>/world.json`, the single-player save format, plus per-player records).
- **Clients generate terrain themselves.** Terrain is a pure function of (seed, gen), so a client builds every chunk
  locally and receives only the world's EDITS and BRICKS — once on joining (≈ 8 bytes an edit; the 300 000-edit cap is
  ≈ 2.3 MB) and then as small deltas. Light and meshes are computed locally as today.
- **Clients send intents, the server decides.** A player's dig, place or use is applied at once on that player's screen
  (no lag) and sent to the server, which checks it, applies it to its World and broadcasts the resulting cells to everyone,
  the sender included; a refused intent is undone by that same broadcast (the server sends the cell's true value).
  Changes the server makes itself (flowing water, falling sand, a blast) reach everyone the same way.
- **Movement is the client's**, checked by the server (speed, not inside solid). Right for a family LAN; tightened for a
  public server in phase 4.
- **One simulation core.** The world systems are already pure modules (world, blockphysics, fluids, worldgen, zombies,
  animals, pigs, populations, survival, crafting, campfires, circuits, weather, daynight, sleep, …: they run under Node in
  the tests). Today main.js orchestrates them for one player. Phases 2–3 move that orchestration into `src/sim/`, used by
  the server (and by single-player), so the two can never drift apart.

## 3. The protocol (JSON over WebSocket, version 1)

Every message is an object with a type `t`. Unknown types are ignored; a `v` mismatch in `hello` is refused with a message.

| from | t | fields |
|---|---|---|
| client | `hello` | `v`, `name`, `avatar`, `token` (a random id the browser keeps, so a player who reconnects is the same player) |
| server | `welcome` | `v`, `id`, `world: { seed, gen, mode, time, day, name }`, `edits`, `bricks`, `players: [{ id, name, avatar, pose }]`, `spawn` |
| server | `refused` | `reason` (version, full, bad hello) |
| client | `pose` | `x, y, z, yaw, pitch, flying, sneaking, vx, vz, onGround, swing` — 15 times a second while it changes |
| server | `poses` | `[[id, x, y, z, yaw, pitch, flags, vx, vz], …]` — 15 times a second, the others' |
| server | `join` / `leave` | `{ id, name, avatar }` / `{ id }` |
| client | `set` | `{ q, y, r, id }` — place or break a hex (intent) |
| client | `brick` | `{ i, y, n, id }` — place or break a brick (intent) |
| server | `cells` | `[q, y, r, id, …]` — every hex cell that changed this tick (players' and the server's own) |
| server | `bricks` | `[i, y, n, id, …]` — every brick that changed |
| server | `time` | `{ time, day }` — every 5 s (clients run the clock between) |
| both | `chat` | `{ text }` (server adds `from`) |
| both | `ping` / `pong` | `{ at }` |

Later phases add `ents` (entity snapshots: mobs, animals, loose items, falling blocks — only those near each player), `fx`
(sounds and particles of the server's events), `act` (survival actions: dig progress, use, craft, drop, throw, eat …) and
`me` (the player's own pack, wear and vitals).

## 4. Phases

1. **A shared world (now).** The server (world authority, saves, block physics, the protocol); "Join this server" on the
   title screen; terrain from the seed, edits and bricks synced both ways; everyone sees everyone as their avatar, named;
   the clock shared; touch controls for the iPad. Multiplayer worlds are **Creative** in phase 1 (mobs off). *Built: see
   src/CONTRACTS.md §96 and server/README.md (hosting, the WSL2 port).*
2. **The world's life on the server.** Fauna, animals, pigs, zombies and the Watcher; campfires, circuits, runes, loose
   items, weather — each aware of several players (the nearest one is chased; spawning and live zones round every
   player). Entity snapshots with interest management; clients interpolate them. Sounds and particles as `fx`.
3. **Survival together.** Each player's pack, wear, vitals, crafting lanes, digging and harvest, eating, drinking, fire
   spots, death and respawn on the server; baskets shared; the night is skipped when every player sleeps.
4. **A real server.** A config file (port, world, password or invite codes), `wss://` behind a reverse proxy, reconnect,
   rate limits, admin commands, scheduled backups.

## 5. Touch controls (iPad)

- Detected by `pointer: coarse` / touch points (iPadOS reports itself as a Mac with touch), with a switch in the menu.
- **Left thumb**: a floating joystick (where the thumb lands) moves; pushed to the edge it sprints. **Right half**: drag
  to look (no pointer lock on iPad).
- **Buttons** (right side): jump (hold to rise when flying), dig / strike (hold), place / use (tap), R (the action key),
  sneak, fly (Creative). Top: pause, pack (E), chat. The hotbar is tapped to select.
- The pack, the handbook and every menu already work by tapping (they are DOM); text needs no keyboard but chat.
- The page never zooms or scrolls (`touch-action: none`, no double-tap zoom), and is a home-screen web app
  (`apple-mobile-web-app-capable`, a manifest) so it opens full screen.
- iPads start with a shorter view distance (4) and can raise it.

## 6. Hosting at home (the WSL2 detail)

The PC runs the game under WSL2 in NAT mode: the server listens inside WSL, which the iPads cannot reach directly. Either
forward the port on Windows (`netsh interface portproxy` + a firewall rule, as administrator) or switch WSL to mirrored
networking (`.wslconfig: networkingMode=mirrored`). `server/README.md` gives both; the server prints the address the iPads
open (under NAT that is WSL's own address: the iPads use the PC's Wi-Fi address instead).

## 7. Risks

- **iPad performance**: WebGL on an iPad is fine for the honeycomb at view distance 4–5; meshing is the CPU cost.
- **Main.js is 7 800 lines**: phase 1 adds a thin network layer beside it rather than moving it; phases 2–3 do the move,
  one system at a time, each behind the existing tests.
- **Time and physics depend on frame timing** today (one 50 ms physics tick a frame); the server runs a fixed 20 Hz tick.
- **Old browser saves** cannot be joined; a server can start from one (a save exported from the PC's browser as a file).
