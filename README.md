# Caelancraft

A Minecraft-style voxel sandbox that runs in your browser. Infinite procedurally generated terrain with
biomes, caves, ores, trees and oceans; first-person movement with collision, swimming and flight; break and
place two dozen block types; a day/night cycle; and worlds that save themselves in the browser.

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
| Debug overlay | `F3` |
| Pause / release mouse | `Esc` |

## URL parameters

| Parameter | Effect |
|---|---|
| `?seed=123` | World seed (number or any text) |
| `?rd=6` | Render distance in chunks (1–16) |
| `?debug=1` | Start with the debug overlay visible |
| `?nosave=1` | Do not read or write saved worlds |
| `?time=0.5` | Freeze the time of day (0 = midnight, 0.5 = noon) |
| `?fly=1` | Start in fly mode |
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

- `src/` — game modules. `src/CONTRACTS.md` documents every module's public interface.
- `tests/unit/` — one test file per pure module; `tests/integration/harness.test.js` drives the whole
  game loop headlessly with a stub renderer.
- `docs/SPEC-gameplay.md` — block palette, texture recipes, terrain numbers, controls, UI, day/night, saves.
- `docs/SPEC-engine.md` — engine architecture and algorithms.
- `docs/PLAN-build.md` — toolchain, test plan, verification gates.

## Saved worlds

Worlds are stored in `localStorage` under keys starting with `caelancraft:v1:`. Use **New World** on the
title screen to start over (it asks before deleting), or clear site data in the browser.
