# Caelancraft

A honeycomb voxel sandbox that runs in your browser. The world is built from **hexagonal prisms** instead of
cubes: every cell of terrain, every block you place, every wall you walk along and every surface you look at is a
hex, and the physics, ray casting, meshing and streaming are all native to the honeycomb rather than a cube grid
with a hex skin. Infinite procedurally generated terrain with biomes, caves, ores, trees and oceans; first-person
movement with sliding collision, swimming and flight; break and place two dozen block types; a day/night cycle
with a glowing sky; and worlds that save themselves in the browser.

Everything is generated at runtime — no textures, models, sounds or fonts are downloaded.
Built with [Three.js](https://threejs.org/) and [Vite](https://vite.dev/) in plain JavaScript.

## Quick start

Requires Node.js 22.12 or newer and a browser with WebGL2.

```bash
npm install
npm run dev
```

Open the URL Vite prints (normally `http://localhost:5173`). On WSL2 the Windows browser reaches it at
`localhost` too; if that ever fails, use the `Network:` address Vite prints, or run `hostname -I` and
open `http://<that-ip>:5173`.

## The honeycomb

- Cells are pointy-top hexagonal prisms, 1 unit wide across the flats and 1 unit tall, addressed by axial
  coordinates `(q, r)` plus a height `y`. The cell centre in world space is `(q + r/2, r·√3/2)`.
- Each cell has eight faces: six sides (E, SE, SW, W, NW, NE) plus top and bottom. Placing a block puts it on the
  far side of the face you are looking at — including the six slanted sides.
- The player is a cylinder; it slides along honeycomb walls instead of snapping to axes.
- Chunks are 16×16 cells in `(q, r)` and stream in a hexagon around you (hex distance in chunk space), so the
  loaded world is round rather than square.
- Terrain noise is sampled at each cell's true world position, so hills, biomes and caves are isotropic — no
  shearing along the hex axes.

## Commands and Rune Blocks

Press **T** (or **/**) for the command console. Commands are one per line; `help` lists them. Block commands take
**cell** coordinates `q y r` (the F3 overlay shows your cell and the targeted cell), `tpw` takes world `x y z`.
`~` means "relative to me" (`~`, `~3`, `~-1`); inside a Rune Block script `@` means "relative to this rune block".

| command | what it does |
|---|---|
| `tp q y r` · `tp q r` · `tpw x y z` | teleport to a cell (or onto the surface there) / to a world position |
| `look yaw pitch` | look direction in degrees (`look north 0`, `look ~30 ~`) |
| `setblock q y r <block>` | one cell (`blocks` lists the names) |
| `fill q1 y1 r1 q2 y2 r2 <block>` | an axial box |
| `hexfill q y r radius height <block>` · `hexring …` | a honeycomb disc or ring, `height` cells tall |
| `time set noon|midnight|day|night|HH:MM` · `time add 1h` | the clock |
| `fly on|off|toggle`, `give <block> [slot]`, `say <text>`, `pos`, `seed`, `edits` | utilities |
| `run q y r`, `wait <s>`, `stop`, `stopall`, `resume`, `runes`, `rune q y r on|off` | rune scripting |

A **Rune Block** (in the block picker) stores a script. Place one and its editor opens (**Shift+R** reopens it; **R** runs it).
Its editor exposes four triggers you can combine: **Interact** (press R while looking at it), **Step on** (walk onto it, with a
cooldown — being teleported onto it does not count), **Repeat** every N seconds while its chunk is loaded, and **Chain** (when its
script finishes, the rune blocks touching any of its eight faces run next; `stop` ends a script without chaining). Every rune runs
at most once per activation, so loops of chained runes terminate. Scripts and settings are saved with the world. If a script runs
away, `stopall` in the console (or **Stop All Rune Scripts** in the pause menu) cancels everything and pauses the triggers.

## Controls

| Action | Keys |
|---|---|
| Move | `W` `A` `S` `D` (or arrow keys) |
| Jump / swim up / fly up | `Space` |
| Sneak / fly down | `Shift` |
| Sprint | double-tap `W` |
| Toggle flying | double-tap `Space` or `F` |
| Break block | Left mouse button |
| Place block | Right mouse button |
| Pick targeted block into hotbar | Middle mouse button |
| Choose hotbar slot | `1`–`9` or mouse wheel |
| Block picker | `E` |
| Command console | `T` (or `/` to start a command) |
| Run / edit the targeted Rune Block | `R` / `Shift+R` |
| Debug overlay | `F3` |
| Pause / release mouse | `Esc` |

## URL parameters

| Parameter | Effect |
|---|---|
| `?seed=123` | World seed (number or any text) |
| `?rd=6` | Render distance in chunks (1–16, hex distance) |
| `?debug=1` | Start with the debug overlay visible |
| `?nosave=1` | Do not read or write saved worlds |
| `?time=0.5` | Freeze the time of day (0 = midnight, 0.5 = noon) |
| `?fly=1` | Start in fly mode |
| `?yaw=90&pitch=-30` | Initial look direction in degrees (yaw 0 = north, 90 = west, 180 = south, 270 = east; negative pitch looks down) |
| `?ui=console` / `?ui=editor` | With `?autoplay=1`: open the console, or place a sample Rune Block ahead and open its editor (screenshots; use with `?nosave=1` — the editor variant writes to the world) |
| `?autoplay=1` | Skip the title screen |
| `?smoke=1` | Run the built-in self-test and show the result banner |

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build on port 4173 |
| `npm test` | Unit and integration tests (Vitest, no browser needed) |
| `npm run lint` | ESLint over `src`, `tests`, `scripts` |
| `npm run typecheck` | JSDoc type check with TypeScript (advisory) |
| `npm run check` | lint + test + build |
| `npm run smoke:win` | Headless smoke test using the Windows-side Chrome from WSL2 |

## Project layout

- `src/` — game modules. `src/CONTRACTS.md` documents every module's public interface and is the normative
  description of the hex geometry (`src/hex.js`), meshing, physics, ray casting, the command language
  (`src/commands.js`) and Rune Blocks (`src/runes.js`).
- `tests/unit/` — one test file per pure module; `tests/integration/harness.test.js` drives the whole
  game loop headlessly with a stub renderer.
- `docs/SPEC-gameplay.md` — block palette, texture recipes, terrain numbers, controls, UI, day/night, saves.
- `docs/SPEC-engine.md` — engine architecture and algorithms.
- `docs/PLAN-build.md` — toolchain, test plan, verification gates.

Where the `docs/` specifications still describe cubes, `src/CONTRACTS.md` wins.

## Saved worlds

Worlds are stored in `localStorage` under keys starting with `caelancraft:v2:`. Saves from the cube-based v0.1
(`caelancraft:v1:`) are not loadable — their edits were addressed on a square grid. Use **New World** on the
title screen to start over (it asks before deleting), or clear site data in the browser.
