# Caelancraft

A honeycomb voxel sandbox that runs in your browser. The world is built from **hexagonal prisms** instead of
cubes: every cell of terrain, every block you place, every wall you walk along and every surface you look at is a
hex, and the physics, ray casting, meshing and streaming are all native to the honeycomb rather than a cube grid
with a hex skin. Infinite procedurally generated terrain with biomes, caves, ores, trees and oceans; first-person
movement with sliding collision, swimming and flight; break and place dozens of block types; a day/night cycle
with a glowing sky; a **Survival** mode with a body to look after, tools from flint to steel and cooking on the
campfire; real-world **circuits** — powder fuses and torches, batteries, switches, timers, relays and spark radio — that set
off **powder kegs** and **Collapsar Charges** whose black holes swallow the land in a spiralling vortex; and worlds that save
themselves in the browser.

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
| `mode [creative\|survival]` (console only), `vitals [full\|health …] [value]`, `pack [list\|add\|clear] [item] [count]`, `items [filter]` | Survival |

A **Rune Block** (in the block picker) stores a script. Place one and its editor opens (**Shift+R** reopens it; **R** runs it).
Its editor exposes four triggers you can combine: **Interact** (press R while looking at it), **Step on** (walk onto it, with a
cooldown — being teleported onto it does not count), **Repeat** every N seconds while its chunk is loaded, and **Chain** (when its
script finishes, the rune blocks touching any of its eight faces run next; `stop` ends a script without chaining). Every rune runs
at most once per activation, so loops of chained runes terminate. Scripts and settings are saved with the world. If a script runs
away, `stopall` in the console (or **Stop All Rune Scripts** in the pause menu) cancels everything and pauses the triggers.

## Survival

Every world has a mode, **Creative** (the sandbox above, unchanged) or **Survival**, switched in the pause menu (`Esc` →
**Mode** `[ Creative | Survival ]`) or with the console command `mode survival` / `mode creative`. The mode is saved with the
world and can be flipped at any time; neither inventory ever turns into the other, and a Survival state switched back to
Creative is kept frozen for the next time.

In Survival you have a body — **Health**, **Nourishment**, **Hydration** and **body temperature** sit either side of the hex
hotbar, and **Breath** darkens the Health cell's border edge by edge under water. Blocks are dug by **holding** the left mouse
button (a honey outline traces the cell as you dig); some need a tool of a high enough tier, and what you dig goes into your
**Pack** (`E`: 27 hex slots, a rosette around the hotbar, plus head / body / feet). Making is a list of recipes filtered by what
you carry and which workplaces are near — your hands, a Work Stump, a Kiln, a Bloomery, a Forge — each with its own lane, so
they all work at once. The tools go from stone and knapped flint through copper and bronze to iron and steel. Right mouse uses
the item in hand (place, eat, drink, bandage, wear); `R` drinks water (fresh from ponds, salty from the sea), picks berries and
loose stones, tends a campfire's six skewers and its pot in the embers, taps birch sap, opens baskets, sleeps on a Sleeping
Hide (which is then where you wake after a death), and takes back **Your Belongings** after a death. You grow tired as the
hours awake add up: sleep takes them off and heals you, and a place walled against the night is the only safe one to sleep in. Survival-placed campfires need feeding and burn out to a cold pit.
Every new Survival game starts with a **Survival Handbook** in the last hotbar slot (hold it and press `R`); the same text is
the **Guide** on the title screen and in the pause menu.

**Survival resources and old worlds.** Survival adds a few things to world generation: copper and tin ores, clay beds, wild
plants, loose stones and fallen branches, small fresh-water ponds, and spruce and birch trees ("generation 2"). **New worlds get
them unless you clear the "Survival resources" box in the New World form** — so new worlds look a little different even in
Creative; clear the box to keep today's land. **Existing worlds do not change** until they are first switched to Survival: the
pause menu then asks before bringing the survival resources in (they appear wherever the land is untouched, near your builds
too, and this cannot be undone). A world that stays in Creative is never touched. Saves of Survival or generation-2 worlds are
version 3, which older versions of the game show as damaged rather than misread.

## Circuits, powder kegs and black holes

The block picker (`E`) has a **Circuits** section. Everything works the way the real thing did, and every part's settings
panel (**Shift+R** on it) says where it comes from.

- **Mechanical.** A **Powder Fuse** burns 2.5 cells a second, branches where it forks and is gone afterwards; light it with the
  `R` key or set a **Torch** beside it. Whatever it reaches at its end — a **Powder Keg** or a **Collapsar Charge** — goes off.
- **Electrical: one wire out, the earth back.** Every source and load needs **earth** under it (soil or stone that reaches the
  ground; wood, glass and sky platforms do not — run an **Earth Wire** down). Wire volts follow **Ohm's law**: each wire cell
  drops current × resistance, so a long run or many lamps on one wire run dim. **Voltaic Batteries** (stack them into a pile),
  the **Blasting Machine** (24 V for a second) and the **Selenium Panel** (daylight) are the sources; **Knife Switches**, **Push
  Buttons**, **Clockwork Timers** (pulse, hold, repeat) and **Relays** (the telegraph's repeater) are the controls; the
  **Igniter**, the **Filament Lamp** and the **Electric Bell** are the loads. Copper, brown and white wire join only their own
  colour; a **Terminal Board** joins every colour. Wires never glow — look at a lamp, listen to a bell, or point at a part:
  the crosshair hint reads its volts (`volts q y r` in the console gives the exact value).
- **Radio.** A **Spark Transmitter** closes every **Coherer Receiver** on its wavelength (300–1050 m) within range. Holding a
  transmitter in the hotbar makes it a **pocket key**: `R` sends, even while you look at the very keg you want to set off.
- **Right-click works switches, buttons, timers and plungers** instead of placing a block (holding it never places either);
  **Shift+right-click** places against them. `R` on a keg or a charge only explains how to set it off.
- **Powder kegs burn in place**: a fuse, a torch or an igniter sets one off a quarter of a second later; a campfire or `ignite`
  gives you 3 s — a left-click pinches the fuse out. Kegs going off together merge into one blast.
- **Collapsar Charges** are dormant until a fuse, an igniter, a flame, a blast or the radio sets one off: a brilliant flash, an
  implosion, then a black vortex that pulls you, pigs and zombies in on a spiral and visibly tears blocks loose and swallows them.
  Walk straight away to escape. Left-click its core to break it.
- The pause menu's **Devices** row switches circuits and black holes off and on for the world; `circuits on|off`,
  `blackholes on|off|list`, `switch`, `timer`, `radio`, `volts` and `ignite` drive them from the console and from Rune Blocks.
- In **Survival** every part is made at a workplace from what the land gives (pyrite from coal seams, saltpetre from deep cave
  walls, copper, tin and iron); lighting a fuse by hand needs a Fire Drill. Collapsar Charges are Creative-only.

## Controls

| Action | Keys |
|---|---|
| Move | `W` `A` `S` `D` (or arrow keys) |
| Jump / swim up / fly up | `Space` |
| Sneak / fly down | `Shift` |
| Sprint | double-tap `W` |
| Toggle flying (Creative) | double-tap `Space` or `F` |
| Break block (Survival: hold to dig) | Left mouse button |
| Place block (Survival: use the item in hand); work a switch, button, timer or plunger (`Shift`: place against it) | Right mouse button |
| Pick targeted block into hotbar (Survival: select it if the hotbar holds it) | Middle mouse button |
| Choose hotbar slot | `1`–`9` or mouse wheel |
| Block picker (Survival: Pack & Making) | `E` |
| Command console | `T` (or `/` to start a command) |
| Use: a switch, timer, fuse, the radio key or a rune; in Survival also water, fire, plants, basket, belongings, Handbook | `R` |
| Settings of the targeted device, or edit the targeted Rune Block | `Shift+R` |
| Debug overlay | `F3` |
| Pause / release mouse | `Esc` |

## URL parameters

| Parameter | Effect |
|---|---|
| `?seed=123` | World seed (number or any text) |
| `?rd=6` | Render distance in chunks (1–16, hex distance) |
| `?debug=1` | Start with the debug overlay visible |
| `?nosave=1` | Never write saved worlds (the Worlds panel is read-only; `?autoplay=1` starts a fresh world instead of loading one) |
| `?time=0.5` | Freeze the time of day (0 = midnight, 0.5 = noon) |
| `?fly=1` | Start in fly mode |
| `?yaw=90&pitch=-30` | Initial look direction in degrees (yaw 0 = north, 90 = west, 180 = south, 270 = east; negative pitch looks down) |
| `?ui=console` / `?ui=editor` | With `?autoplay=1`: open the console, or place a sample Rune Block ahead and open its editor (screenshots; use with `?nosave=1` — the editor variant writes to the world) |
| `?ui=picker` / `?ui=pack` | With `?autoplay=1`: open the block picker, or (in Survival) the Pack & Making screen — with `?nosave=1` an empty pack is stocked with a demo kit |
| `?ui=device` | With `?autoplay=1`: place a Clockwork Timer ahead and open its settings panel (use with `?nosave=1`) |
| `?ui=sounds` | Open the Sound Test at once (no world needed): every sound of the game with a button that plays it, and ambience scenes. Also under `Esc` → Sound → Sound Test |
| `?scene=vortex` / `?scene=circuits` | With `?autoplay=1`: set off a Collapsar Charge 8 cells ahead 2 s after loading, or build the worked circuit examples (a doorbell, a timed keg, a switch and igniter, a dusk lamp) 10 cells ahead (use with `?nosave=1`); with `?smoke=1` the self-test checks them |
| `?mode=survival` / `?mode=creative` | With `?autoplay=1` or `?smoke=1`: the first world's mode. A saved world older than Survival is not upgraded from a URL (use `Esc` → Mode) unless `?nosave=1` |
| `?autoplay=1` | Skip the title screen |
| `?slot=3` | With `?autoplay=1`: play save slot 1–6 (default 1; with `?nosave=1` nothing is written) |
| `?smoke=1` | Run the built-in self-test and show the result banner (with `?mode=survival` it ends by digging and eating in Survival) |

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
  game loop headlessly with a stub renderer; `tests/integration/survival.test.js` plays a Survival first day on paper and
  `survivalData.test.js` checks that every item can be found or made and every recipe reached.
- `docs/DESIGN-survival.md` — the Survival design (the body, items, harvesting, making, fire, world generation 2, the screens).
- `docs/DESIGN-circuits.md` — black holes v2, powder kegs, the circuits and the creative inventory (worked examples in §4.14;
  `tests/integration/circuits.test.js` plays them cell for cell).
- `docs/SPEC-gameplay.md` — block palette, texture recipes, terrain numbers, controls, UI, day/night, saves.
- `docs/SPEC-engine.md` — engine architecture and algorithms.
- `docs/PLAN-build.md` — toolchain, test plan, verification gates.

Where the `docs/` specifications still describe cubes, `src/CONTRACTS.md` wins.

## Saved worlds

Up to six worlds live side by side in `localStorage`, one key per save slot (`caelancraft:v2:slot:1` … `:6`, plus a small
index `caelancraft:v2:slots`). The title screen's **Worlds** panel lists them — name, seed, when you last played, size — with
Play, Rename, Duplicate and Delete (it asks first), **New World** on every empty slot, and a bar showing how much of the
browser's ~5 MB the worlds use (all slots share it; when a save does not fit, the game says so and the previous save stays).
A save from before save slots (`caelancraft:v2:save`) moves into slot 1 as "My World" on first start. Saves from the cube-based
v0.1 (`caelancraft:v1:`) are not loadable — their edits were addressed on a square grid — and a slot whose save cannot be read
shows as "Damaged world", which can only be deleted.
