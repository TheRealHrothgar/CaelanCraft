# Caelancraft — Module Contracts (NORMATIVE)

Every implementer codes against this document. If `docs/SPEC-gameplay.md`, `docs/SPEC-engine.md` or
`docs/PLAN-build.md` disagree with this file on a name, path, signature, constant or convention, **this file wins**.
If you believe a contract is wrong, do NOT change it: add a `// CONTRACT-ISSUE: ...` comment at the top of your own
file explaining the problem, implement the contract as written, and move on. The integration agent adjudicates.

Plain JavaScript ES modules with JSDoc. No TypeScript. No new npm dependencies. Only `renderer.js` and `atlas.js`
import `three`. Pure modules never touch `window`, `document`, `performance` (except `world.js`, see §9), or `Math.random`.

> **v0.2 — the honeycomb revision.** Caelancraft's world is a honeycomb: every cell is a vertical **hexagonal prism**,
> not a cube. The hex geometry is the fundamental unit of storage, generation, meshing, physics and interaction.
> Where the SPEC documents still describe cubes (block AABBs, 6 faces, Amanatides–Woo), this file supersedes them.
>
> **v0.3 — commands and Rune Blocks.** A typed command console (§26, §28) and a programmable **Rune Block** (§27) whose
> script runs on interact (R), step-on, a repeat timer and/or chains to its neighbours — all four exposed in its editor.
>
> **v0.8 — block physics.** Falling sand and gravel, flowing water, collapsing structures, falling trees and blast barrels,
> all driven by ONE scheduler (§33) with pluggable rules; falling blocks and their rendering (§34); water (§35), support
> and trees (§36), explosives (§37). Design rationale: `docs/DESIGN-physics.md` (its §10 lists the plug-in interfaces).

## 0. Conventions (apply everywhere)

- Axes: +Y up. +X east, −X west, +Z south, −Z north. Angles in the XZ plane are measured from +X toward +Z.
- **Cells are hexagonal prisms**, pointy-top (corners along ±Z), exactly 1 wide across the flats (`HEX_INRADIUS = 0.5`,
  circumradius `HEX_SIZE = 1/√3 ≈ 0.577`) and 1 tall. A cell is addressed by **axial coordinates `(q, r)` plus integer `y`**
  and occupies `[y, y+1)` vertically. Its centre is `hexToWorld(q, r) = (x, z) = (q + r/2, r·√3/2)`; rows (fixed `r`) run
  along +X one unit apart, consecutive rows are `√3/2` apart in Z and shifted by half a cell. The cell containing a world
  point is `worldToHex(x, z)` (cube rounding; exact nearest centre). Everything geometric lives in `src/hex.js`.
- **Faces:** `0..5` are the sides, counter-clockwise seen from +Y with +X right and +Z down: `E, SE, SW, W, NW, NE`.
  Side `j` has outward unit normal `(cos 60°j, 0, sin 60°j)`, which equals the world offset of its neighbour
  `HEX_DIRS[j]` ∈ `[1,0],[0,1],[−1,1],[−1,0],[0,−1],[1,−1]`. Face `6` = top (+Y), face `7` = bottom (−Y).
  `FACE_OPPOSITE = [3,4,5,0,1,2,7,6]`. Corner `k` (0..5) is at angle `60°k − 30°` (`HEX_CORNERS`); side `j` spans corners
  `j` and `j+1`. Exactly three cells meet at every vertical edge, and they are mutually adjacent.
- **World positions** are floats `(x, y, z)`; **cell coordinates** are integers `(q, y, r)`. Every signature below says
  which it takes. `World.getBlock/setBlock` take cells; `World.update/hasChunkAt/isReadyAt/getBlockAt` take world positions.
- Chunk of a cell coordinate `w` (q or r) is `Math.floor(w / 16)`; local coordinate is `w − c*16`. **Never** use `%`, `|0`,
  `~~`, `Math.trunc` or `Math.round` for these — they are wrong for negatives.
- Yaw/pitch: yaw rotates about +Y; **yaw = 0 faces −Z**; positive yaw turns LEFT (counter-clockwise seen from above).
  Pitch positive looks UP, clamped to ±`PITCH_LIMIT`. Camera: `rotation.order = 'YXZ'`, `rotation.set(pitch, yaw, 0)`.
- Chunk = 16 (q) × 128 (Y) × 16 (r). Block ids are integers 0..255 in a `Uint8Array`. `0` is AIR. A chunk's footprint is a
  parallelogram; the chunk lattice is itself a regular hex lattice with spacing 16 in world units, so **chunk distances are
  hex distances**: `hexLength(dcq, dcr) = max(|dq|, |dr|, |dq+dr|)`. The six hex-adjacent chunks of `(cq, cr)` are
  `(cq + HEX_DIRS[j][0], cr + HEX_DIRS[j][1])`; the index-space corners `(±1, ±1)` are NOT adjacent and are never needed.
- Chunk key: the string `` `${cq},${cr}` ``.
- Local index: `localIndex(lq, ly, lr) = (lq * 16 + lr) * 128 + ly` (Y innermost; a column is a contiguous run).
- Per-column arrays (biomes, heights) use index `lq * 16 + lr`.
- Texture atlas: 256×256 px, 16×16 tiles of 16 px. Tile `t` is at pixel `((t % 16) * 16, Math.floor(t / 16) * 16)`.
  `texture.flipY = false`, so UV `v` grows DOWN the image: `v0 = top of tile image`.
- Time of day `t ∈ [0,1)`: 0 = midnight, 0.25 = 06:00, 0.5 = noon, 0.75 = 18:00.
- Distances in blocks (metres), time in seconds, angles in radians. Colours handed between modules are `[r,g,b]`
  floats 0..1 in sRGB unless stated.
- Every function that receives cell coordinates accepts negatives.

## 1. Files and ownership

| File | Kind | Owner | Test file |
|---|---|---|---|
| `src/config.js` | PURE, constants | Wave 0 (done) | `tests/unit/wave0.test.js` |
| `src/types.js` | PURE, JSDoc typedefs only | Wave 0 (done) | — |
| `src/hex.js` | PURE, hex geometry | v0.2 | `tests/unit/hex.test.js` |
| `src/coords.js` | PURE | Wave 0 (done) | `tests/unit/wave0.test.js` |
| `src/blocks.js` | PURE | Wave 0 (done) | `tests/unit/wave0.test.js` |
| `src/chunk.js` | PURE | Wave 0 (done) | `tests/unit/wave0.test.js` |
| `src/noise.js` | PURE | A-noise | `tests/unit/noise.test.js` |
| `src/worldgen.js` | PURE | A-worldgen | `tests/unit/worldgen.test.js` |
| `src/mesher.js` | PURE | A-mesher | `tests/unit/mesher.test.js` |
| `src/world.js` | PURE (+`performance.now` fallback) | A-world | `tests/unit/world.test.js` |
| `src/raycast.js` | PURE | A-raycast | `tests/unit/raycast.test.js` |
| `src/physics.js` | PURE | A-physics | `tests/unit/physics.test.js` |
| `src/daynight.js` | PURE | A-daynight | `tests/unit/daynight.test.js` |
| `src/storage.js` | PURE (storage injected) | A-storage | `tests/unit/storage.test.js` |
| `src/tiles.js` | PURE (pixel painters) | A-tiles | `tests/unit/tiles.test.js` |
| `src/commands.js` | PURE, command language | v0.3 | `tests/unit/commands.test.js` |
| `src/runes.js` | PURE, rune store + runner | v0.3 | `tests/unit/runes.test.js` |
| `src/blockphysics.js` | PURE, physics scheduler + rule registry (§33); the features together (§38) | v0.8 | `tests/unit/blockphysics.test.js`, `tests/integration/physics.test.js` |
| `src/fallingblocks.js` | PURE, fallers / tumblers / gravity rule (§34) | v0.8 | `tests/unit/fallingblocks.test.js` |
| `src/fluids.js` | PURE, flowing water: rule, floor trigger, reseeder, drain, currents (§35) | v0.8 | `tests/unit/fluids.test.js` |
| `src/support.js` | PURE, load-bearing predicates + support search + collapse (§36) | v0.8 | `tests/unit/support.test.js` |
| `src/trees.js` | PURE, falling trees + leaf decay (§36) | v0.8 | `tests/unit/trees.test.js` |
| `src/explosions.js` | PURE, blast barrels (§37) | v0.8 | `tests/unit/explosions.test.js` |
| `src/fallingRenderer.js` | three, moving cells + explosion light (§34.4) | v0.8 | `tests/unit/physicsRender.test.js` |
| `src/particles.js` | three, one particle system (§34.5) | v0.8 | `tests/unit/physicsRender.test.js` |
| `src/atlas.js` | DOM + three | A-atlas | — |
| `src/renderer.js` | three | A-renderer | `tests/unit/renderer.test.js` |
| `src/controls.js` | DOM | A-controls | — |
| `src/hud.js` | DOM | A-hud | — |
| `src/menus.js` | DOM | A-menus | — |
| `src/audio.js` | DOM (WebAudio) | A-audio | `tests/unit/explosionsAudio.test.js` (v0.8 feature sounds) |
| `src/diagnostics.js` | DOM | A-diagnostics | — |
| `src/console.js` | DOM | v0.3 | — |
| `src/runeEditor.js` | DOM | v0.3 | — |
| `src/main.js` | DOM glue | A-main | `tests/integration/harness.test.js` |
| `tests/helpers/fixtures.js` | test helpers | Wave 0 (done) | — |

Import graph (must stay acyclic):
```
config, types, noise, tiles        → (nothing)
hex                                → config
coords                             → config
blocks                             → config, hex
chunk                              → config, coords
daynight                           → config, noise
raycast                            → config, hex, blocks
physics                            → config, coords, hex, blocks
commands                           → config, coords, hex, blocks, physics, daynight (formatTime)
runes                              → config, coords, hex, blocks, commands, physics
fluids, support, trees, explosions → config, blocks (+ hex, coords, physics as needed); never blockphysics
trees                              → … and support (isLoadBearing)
explosions                         → … + noise (hash3), support (isLoadBearing, isAnchorCell)
fallingblocks                      → config, blocks, hex, physics
blockphysics                       → config, blocks, hex, coords, noise (mulberry32), fallingblocks, fluids, support, trees, explosions
fallingRenderer                    → blocks (BLOCK), mesher (buildCellMesh), three
particles                          → config, blocks, tiles (averageColor), mesher (BIOME_TINT, isTintedFace), three
mesher                             → config, coords, hex, blocks
worldgen                           → config, coords, hex, blocks, noise
world                              → config, coords, hex, blocks, chunk, noise (normalizeSeed), worldgen, mesher
storage                            → config, blocks (DEFAULT_HOTBAR), runes (normalizeRunesJSON, validateRunesJSON)
atlas                              → config, blocks, hex, tiles, three
renderer                           → config, hex, three
controls                           → config
hud                                → config, blocks, atlas
menus                              → config, blocks, atlas
audio                              → blocks
diagnostics                        → config, blocks, coords, hex, runes (runeKey)
console                            → config
runeEditor                         → config, commands (parseScript)
main                               → everything except three (renderer, atlas, pigRenderer, campfireRenderer,
                                     fallingRenderer and particles are the three-importing modules)
```

## 2. `src/config.js` (exact — already written)

See the file. Names used below: `CHUNK_SIZE, WORLD_HEIGHT, CHUNK_AREA, CHUNK_VOLUME, SEA_LEVEL, MIN_TERRAIN_HEIGHT,
MAX_TERRAIN_HEIGHT, RENDER_DISTANCE, DATA_RADIUS_EXTRA, UNLOAD_RADIUS_EXTRA, BUILD_BUDGET_MS, MAX_BUILDS_PER_UPDATE,
LOADING_BUDGET_MS, REACH, BREAK_REPEAT_S, PLACE_REPEAT_S, ATLAS_TILE_PX, ATLAS_TILES_PER_ROW, ATLAS_SIZE_PX, TILE_UV,
UV_INSET, WATER_SURFACE_HEIGHT, AO_CURVE, TOP_UV_SCALE, FOG_FAR_CHUNK_MARGIN, PLAYER_WIDTH, PLAYER_HEIGHT, EYE_HEIGHT,
SNEAK_EYE_HEIGHT, GRAVITY, JUMP_VELOCITY, TERMINAL_VELOCITY, WALK_SPEED, SPRINT_SPEED, SNEAK_SPEED, FLY_SPEED,
FLY_SPRINT_SPEED, FLY_VERTICAL_SPEED, GROUND_ACCEL, AIR_ACCEL, WATER_ACCEL, WATER_GRAVITY, WATER_MAX_SINK, SWIM_UP_SPEED,
SWIM_EXIT_JUMP, WATER_SPEED_FACTOR, MAX_SUBSTEP_DT, MAX_FRAME_DT, COLLISION_EPS, FOV, SPRINT_FOV, CAMERA_NEAR,
CAMERA_FAR, MOUSE_SENSITIVITY, PITCH_LIMIT, MAX_PIXEL_RATIO, DOUBLE_TAP_MS, DOUBLE_TAP_SPACE_MS, DAY_LENGTH_SECONDS,
START_TIME, AUTOSAVE_INTERVAL_S, HOTBAR_SIZE, VERSION`.
`VERSION = '0.7.0'`; `package.json` and `package-lock.json` carry the same version and the title footer in `index.html` reads
`Caelancraft v<major>.<minor>` (`v0.7`) — bump all four together (wave0.test.js checks they agree). Render/data/unload radii are
**hex distances** in chunk coordinates. `FACE_SHADE` moved to `hex.js` (it derives from the face normals).
`TOP_UV_SCALE = √3/2` (hex caps are inscribed in their tile).
Commands / runes: `GAME_SECONDS_PER_DAY, MAX_FILL_CELLS, MAX_TOTAL_EDITS, MAX_CELLS_PER_FRAME, MAX_COMMANDS_PER_FRAME,
MAX_RUNNING_SCRIPTS, MAX_CHAIN_HOPS, CHAIN_DELAY_S, MAX_RUNES, MAX_RUNE_SCRIPT_CHARS, MAX_RUNE_SCRIPT_LINES, MAX_RUNE_LABEL_CHARS,
WAIT_MIN_S, WAIT_MAX_S, REPEAT_MIN_S, REPEAT_MAX_S, STEP_COOLDOWN_MAX_S, AREA_MAX_RADIUS, AREA_MAX_HEIGHT, MAX_CONSOLE_LINES,
CONSOLE_HISTORY, CHAT_LINES, CHAT_LINE_MS` (values in the file; §26–§28 use them by name).
Block physics (v0.8, §33–§38): `PHYSICS_TICK_S, WATER_TICKS, PHYSICS_TICK_BUDGET_MS, MAX_CELL_UPDATES_PER_TICK,
MAX_SUPPORT_VISITS_PER_TICK, SUPPORT_STARVED_VISITS, MAX_PARKED_UPDATES, MAX_PENDING_SUPPORT_SEEDS,
UNDO_WINDOW_S, UNDO_MAX_CELLS, LAZY_MESH_BUDGET_MS, MAX_FALLING, MAX_TUMBLING, MAX_COLUMN_FALL, FALLER_RADIUS, FALLER_HEIGHT,
TUMBLE_SUBSTEP, TUMBLE_AIR_DRAG, TUMBLE_GROUND_FRICTION, LANDING_DUST_PER_FRAME, PARTICLE_CAPACITY, PHYSICS_SOUND_RANGE,
BOOM_SOUND_RANGE, SPLASH_MIN_INTERVAL_S, HISS_MIN_INTERVAL_S, FIZZLE_MIN_INTERVAL_S, WATER_CURRENT, DRAIN_MAX_RADIUS, DRAIN_DEFAULT_RADIUS, SUPPORT_LIMIT,
TREE_MAX_CELLS, TREE_MAX_TOPPLING, TREE_QUEUE_GAP_S, TREE_SHAKE_S, TREE_THETA0, TREE_CAUSE_RANGE, BARREL_FUSE_S, MAX_LIT_BARRELS,
MAX_EXPLOSIONS_PER_FRAME, MAX_DEBRIS, BLAST_RADIUS, BLAST_MAX_RADIUS, BLAST_CHAIN_WINDOW_S, BLAST_CHAIN_DISTANCE, BLAST_IMPULSE,
BLAST_MIN_UP, BLAST_SHAKE_RANGE, BLAST_FLASH_S`; water as built (§35): `WATER_SOURCE_NEIGHBOURS, WADE_DEPTH, WADE_SPEED_FACTOR`;
collapse and trees as built (§36): `TREE_LEAF_RADIUS, TREE_LEAF_ABOVE, TREE_MAX_QUEUED, TREE_SHAKE_ANGLE, TREE_SHAKE_WOBBLES,
TREE_SUBSTEP_S, TREE_KNOCK_RADIUS, TREE_KNOCK_SPEED, TREE_KNOCK_UP, TREE_LEAF_PARTICLES, LEAF_DECAY_RANGE, LEAF_DECAY_S`; explosives
as built (§37): `BARREL_TIMER_FUSE_MIN_S, BARREL_TIMER_FUSE_MAX_S, MAX_FUSE_TIMERS, BARREL_HISS_S, BARREL_PULSE_SCALE,
BARREL_PULSE_HZ, BLAST_JITTER, DEBRIS_SPEED_MIN, DEBRIS_SPEED_MAX, DEBRIS_UP_MIN, DEBRIS_UP_MAX, DEBRIS_SPIN, BLAST_DUST_CELLS,
BLAST_FLASH_INTENSITY, BLAST_SHAKE_S, BLAST_SHAKE_AMPLITUDE`
(values in the file, section "Block physics"). Every physics tunable lives there.
`PLAYER_WIDTH = 0.56`: `PLAYER_WIDTH / 2` MUST stay below `HEX_SIZE / 2 ≈ 0.289` (physics.js throws at import otherwise) — every
1-cell-wide passage is pinched to exactly one edge length (`HEX_SIZE ≈ 0.577`) by the two wall corners flanking the shared edge, and
the player must fit through it; that bound also implies the `< HEX_INRADIUS` bound the 7-column collider needs. `FOG_FAR_CHUNK_MARGIN = -1`.

## 3. `src/types.js` (exact — already written)

Typedefs: `BlockId, ChunkKey, FaceIndex (0..7), RenderLayer, Vec3, GetBlockFn ((q, y, r) → BlockId), ChunkData, GetChunkDataFn
((cq, cr) → ChunkData|null), MeshData (+ indexCount), ChunkMeshData, RaycastHit ({q, y, r, face, nx, ny, nz, distance, blockId}),
ColumnInfo, WorldGen (getColumn(q, r), generateChunk(cq, cr)), PlayerState, PlayerInput, SkyState, EditsJSON, Rune, RunesJSON,
SaveData (version 2, optional `runes`), SmokeResult, GameContext (+ runCommand, runes, runner)`. Import in JSDoc as `/** @typedef {import('./types.js').MeshData} MeshData */`.

## 4. `src/coords.js` (exact — already written)

`floorDiv(a,n)`, `mod(a,n)`, `worldToChunk(w)` (cell coordinate → chunk coordinate), `worldToLocal(w)`, `chunkKey(cq,cr)`,
`parseChunkKey(key)` (strict inverse: anything not matching `/^(-?\d+),(-?\d+)$/` → `[NaN, NaN]`), `localIndex(lq,ly,lr)`,
`indexToLocal(index)`, `columnIndex(lq,lr)`, `inHeightRange(y)`,
`yawToForward(yaw) → [fx,fz] = [-sin, -cos]`, `yawToRight(yaw) → [cos, -sin]`,
`lookDirection(yaw,pitch) → [-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch)]`,
`forEachEditedCell(edits, id, fn(q, y, r))` (v0.7: every World.edits entry with that id; malformed chunk keys skipped).
v0.8: `packCell(q, y, r)` → `((q + 2^20)·2^21 + (r + 2^20))·128 + y`, one exact double below 2^49 (the physics queues'
numeric cell key); `unpackCell(key, out = [0,0,0])` → `out = [q, y, r]`.
The cube face tables (`FACE_*`, `FACE_VERTS`) are gone; face geometry is in `hex.js`.

## 4a. `src/hex.js` (exact — already written)

```js
export const SQRT3, HEX_SIZE = 1/√3, HEX_INRADIUS = 0.5, HEX_ROW_SPACING = √3/2, HEX_AREA = √3/2;
export const SIDE_FACE_COUNT = 6, FACE_TOP = 6, FACE_BOTTOM = 7, FACE_COUNT = 8;
export const HEX_DIRS            // [[1,0],[0,1],[-1,1],[-1,0],[0,-1],[1,-1]]  index = side face
export const FACE_OPPOSITE       // [3,4,5,0,1,2,7,6]
export const FACE_NAMES          // ['E','SE','SW','W','NW','NE','top','bottom']
export const FACE_NORMALS        // [nx,ny,nz] × 8; side j = (cos 60°j, 0, sin 60°j) exactly (0.5 / √3/2 literals)
export const HEX_CORNERS         // [dx,dz] × 6; corner k at angle 60°k − 30°, |corner| = HEX_SIZE
export const SHADE_KEY_ANGLE = π/12 // 15°: not a multiple of 30°, so no two side faces share a shade
export const FACE_SHADE          // top 1.0, bottom 0.55, sides 0.8 + 0.1·(n · key) with key at SHADE_KEY_ANGLE (rounded to 3 dp): all six distinct
export const CHUNK_SPACING = 16, CHUNK_RING_INRADIUS = 16·√3/2;
export function hexToWorld(q, r) → [x, z]              // (q + r/2, r·√3/2)
export function worldToHexFrac(x, z) → [qf, rf]
export function hexRound(qf, rf) → [q, r]              // cube rounding; never −0
export function worldToHex(x, z) → [q, r]
export function hexLength(dq, dr), hexDistance(q1, r1, q2, r2), hexNormSq(dq, dr) (= dq² + dq·dr + dr² ∝ world distance²)
export function hexNeighbor(q, r, j) → [q, r];  faceNeighbor(q, y, r, face) → [q, y, r];  hexDiscCount(radius) = 3r² + 3r + 1
export function chunkOrigin(cq, cr) → [x, z]           // = hexToWorld(cq*16, cr*16): where the renderer places the chunk mesh
export function hexSignedDistance(hx, hz, px, pz)      // < 0 inside, 0 on the boundary, > 0 outside (to the nearest edge segment)
export function hexContains(q, r, px, pz)
export function hexCircleContact(hx, hz, px, pz, radius, out) // STRICT overlap decided on depth = radius − dist (> 0 on every true; an exactly
                                                       // tangent circle is NOT a contact); writes out.depth, out.nx/out.nz (unit push, hexagon → circle)
```
Invariants: `worldToHex(hexToWorld(q, r) + any offset inside the hexagon) === [q, r]`; `hexToWorld(HEX_DIRS[j])` is a unit
vector equal to `FACE_NORMALS[j]`; the midpoint of corners `j, j+1` equals `FACE_NORMALS[j] · HEX_INRADIUS`.

## 5. `src/blocks.js` (exact — already written)

Block ids (`BLOCK.*`): `AIR 0, STONE 1, GRASS_BLOCK 2, DIRT 3, COBBLESTONE 4, OAK_PLANKS 5, BEDROCK 6, WATER 7,
SAND 8, GRAVEL 9, OAK_LOG 10, OAK_LEAVES 11, GLASS 12, COAL_ORE 13, IRON_ORE 14, GOLD_ORE 15, DIAMOND_ORE 16,
SANDSTONE 17, SNOW_BLOCK 18, SNOWY_GRASS 19, BRICKS 20, BOOKSHELF 21, STONE_BRICKS 22, WOOL_WHITE 23, WOOL_RED 24,
RUNE_BLOCK 25`, then the v0.4 batch (appended so v2 saves keep their ids): `SPRUCE_LOG 26, SPRUCE_PLANKS 27, SPRUCE_LEAVES 28,
BIRCH_LOG 29, BIRCH_PLANKS 30, BIRCH_LEAVES 31, GRANITE 32, DIORITE 33, ANDESITE 34, SLATE 35, MOSSY_COBBLESTONE 36,
MOSSY_STONE_BRICKS 37, OBSIDIAN 38, CLAY 39, RED_SAND 40, ICE 41, PACKED_ICE 42, COAL_BLOCK 43, IRON_BLOCK 44, GOLD_BLOCK 45,
DIAMOND_BLOCK 46, COPPER_BLOCK 47, GLOWSTONE 48, HONEYCOMB_BLOCK 49, HAY_BALE 50, PUMPKIN 51, WOOL_ORANGE 52, WOOL_YELLOW 53,
WOOL_LIME 54, WOOL_GREEN 55, WOOL_CYAN 56, WOOL_LIGHT_BLUE 57, WOOL_BLUE 58, WOOL_PURPLE 59, WOOL_MAGENTA 60, WOOL_PINK 61,
WOOL_BROWN 62, WOOL_BLACK 63, WOOL_GRAY 64, WOOL_LIGHT_GRAY 65`, v0.5 `BLACK_HOLE 66` (§29), v0.7 `CAMPFIRE 67` (§32).
v0.8 (block physics, §33–§37): `WATER_FLOW_1 … WATER_FLOW_6 68…73, WATER_FALL 74, BLAST_BARREL 75`; **`BLOCK_COUNT = 76`**
(68 before v0.8). All v0.4 blocks are solid, breakable and
placeable, use existing sound groups, and are never emitted by worldgen. Spruce/birch leaves are cutout with `cullSame: false`
(like oak); ICE is solid, non-opaque, `LAYER_TRANSLUCENT`, `cullSame: true`; PACKED_ICE is opaque. Logs and hay bales use
`tiles(side, end)`; pumpkin `tiles(side, top)`. GLOWSTONE only looks lit (no block-light engine). `RUNE_BLOCK` ("Rune Block") is solid, opaque, breakable, placeable, soundGroup stone, tile
RUNE on all faces; its script lives in `runes.js` (§27), never in the chunk array. Worldgen never emits it.

Tile ids (`TILE.*`): `STONE 0, DIRT 1, GRASS_TOP 2, GRASS_SIDE 3, COBBLESTONE 4, OAK_PLANKS 5, BEDROCK 6, WATER 7,
SAND 8, GRAVEL 9, OAK_LOG_SIDE 10, OAK_LOG_END 11, OAK_LEAVES 12, GLASS 13, COAL_ORE 14, IRON_ORE 15, GOLD_ORE 16,
DIAMOND_ORE 17, SANDSTONE_TOP 18, SANDSTONE_SIDE 19, SNOW 20, SNOWY_GRASS_SIDE 21, BRICKS 22, BOOKSHELF 23,
STONE_BRICKS 24, WOOL_WHITE 25, WOOL_RED 26, RUNE 27`, v0.4 `SPRUCE_LOG_SIDE 28, SPRUCE_LOG_END 29, SPRUCE_PLANKS 30,
SPRUCE_LEAVES 31, BIRCH_LOG_SIDE 32, BIRCH_LOG_END 33, BIRCH_PLANKS 34, BIRCH_LEAVES 35, GRANITE 36, DIORITE 37, ANDESITE 38,
SLATE 39, MOSSY_COBBLESTONE 40, MOSSY_STONE_BRICKS 41, OBSIDIAN 42, CLAY 43, RED_SAND 44, ICE 45, PACKED_ICE 46, COAL_BLOCK 47,
IRON_BLOCK 48, GOLD_BLOCK 49, DIAMOND_BLOCK 50, COPPER_BLOCK 51, GLOWSTONE 52, HONEYCOMB 53, HAY_BALE_SIDE 54, HAY_BALE_TOP 55,
PUMPKIN_SIDE 56, PUMPKIN_TOP 57, WOOL_ORANGE 58 … WOOL_LIGHT_GRAY 71` (wool in BLOCK order), v0.5 `BLACK_HOLE 72`, v0.7 `CAMPFIRE_SIDE 73, CAMPFIRE_TOP 74`, `MISSING 255`.
v0.8 `BARREL_SIDE 75, BARREL_TOP 76`. `TILE_IDS` = array of all 78 tile ids.
**Water family** (WATER, FLOW_1..6, FALL): `liquid: true, solid: false, opaque: false, LAYER_TRANSLUCENT, breakable: false`;
FLOW/FALL are `placeable: false`, named `water_flow_k` / `water_fall`, tiles = WATER on every face. **BLAST_BARREL** ("Blast
Barrel"): solid, opaque, placeable, breakable, soundGroup wood, `tiles(BARREL_SIDE, BARREL_TOP)` (lid on top and bottom).
`BlockDef.gravity` (default false) is true for SAND, RED_SAND, GRAVEL. `UNLOADED = 255` is the sentinel `World.peekBlock`
returns for unloaded chunks (never a block id; every predicate treats it like AIR). v0.8 helpers: `isGravityBlock(id)`,
`isWater(id)` (the family), `isWaterSource(id)` (WATER only), `waterLevel(id)` (WATER, FALL → 7; FLOW_k → k; else 0),
`isFallThrough(id)` (AIR, CAMPFIRE and the whole water family — a WATER source too since the water feature, §35.6 — NOT UNLOADED),
`isLeaves(id)`, `isLog(id)` (oak, spruce, birch), `waterSurfaceHeight(id, aboveId)` (§35.4: 0 for non-water; 1 when `aboveId` is water;
else `WATER_SURFACE_HEIGHT` for WATER / FALL and `k/7 · WATER_SURFACE_HEIGHT` for FLOW_k).

Layers: `LAYER_OPAQUE 0` (everything else), `LAYER_CUTOUT 1` (OAK/SPRUCE/BIRCH_LEAVES, GLASS), `LAYER_TRANSLUCENT 2` (WATER, ICE).

Biomes: `BIOME.OCEAN 0, BEACH 1, PLAINS 2, FOREST 3, DESERT 4, SNOWY 5, MOUNTAINS 6, SNOWY_PEAKS 7`, `BIOME_NAMES`.

`BLOCKS[id]` → `{ id, name, displayName, tiles:[8], solid, opaque, liquid, breakable, placeable, cullSame, layer, soundGroup }`.
`tiles` has **8 entries indexed by face**: six sides, then top (6), then bottom (7).
Functions: `getBlockDef(id)` (unknown → the AIR def), `isSolid, isOpaque, isLiquid, isBreakable, isPlaceable,
isReplaceable (AIR or liquid), isTargetable (not AIR and not liquid), getRenderLayer, getFaceTile(id, face 0..7),
shouldRenderFace(a, b), tileToUV(tile) → [u0, v0, u1, v1]`. Re-exports `FACE_TOP, FACE_BOTTOM` from hex.js.
Constants: `DEFAULT_HOTBAR` (9 ids), `PICKER_ORDER` (all 67 placeable ids, once each, grouped stone / earth / wood / minerals /
wool / special, ending CAMPFIRE, BLAST_BARREL, BLACK_HOLE, RUNE_BLOCK, WATER), `SOUND_GROUPS`.
v0.7: `BlockDef.meshed` (default true) and `isMeshed(id)`. A block with `meshed: false` (only CAMPFIRE) is skipped by the mesher
and drawn by its own model; its tiles are used only for icons.

Culling rule (`shouldRenderFace(a, b)`, `a` = this block, `b` = neighbour across the face):
```
if a === AIR            → false
if isOpaque(a)          → !isOpaque(b)
if b === a              → !BLOCKS[a].cullSame        (water/glass: cull; leaves: render)
otherwise               → !isOpaque(b)
```
UV rule: `tileToUV(t)`: `tx = t % 16, ty = floor(t/16)`, `u0 = tx*TILE_UV + UV_INSET`, `u1 = (tx+1)*TILE_UV − UV_INSET`,
`v0 = ty*TILE_UV + UV_INSET` (image top), `v1 = (ty+1)*TILE_UV − UV_INSET` (image bottom).

## 6. `src/chunk.js` (exact — already written)

```js
export class Chunk {
  constructor(cq, cr, data)   // data: ChunkData; arrays adopted, not copied. Missing data → zero-filled arrays.
  cq; cr; key;                // key = chunkKey(cq, cr)
  blocks; biomes; heights;    // Uint8Array(CHUNK_VOLUME), Uint8Array(CHUNK_AREA), Uint8Array(CHUNK_AREA)
  dirty = true;               // needs (re)meshing
  lazy = false;               // v0.8: dirty only through lazy writes (World §9.2) — re-meshed under LAZY_MESH_BUDGET_MS
  meshed = false;             // has been handed to the renderer at least once
  get(lq, ly, lr)             // BlockId; returns AIR (0) when out of range
  set(lq, ly, lr, id)         // returns true iff the value changed (then dirty = true); false when out of range
}
```
A `Chunk` structurally satisfies `ChunkData`.

## 7. `src/noise.js`

```js
export function hashString(str)            // FNV-1a 32-bit over UTF-16 code units → uint32
export function normalizeSeed(seed)        // number: integer → >>>0; other number → hashString(String(n));
                                           // string matching /^-?\d+$/ → Number(s) >>> 0; other string → hashString(s);
                                           // undefined/null → 0
export function mulberry32(seed)           // → () => number in [0,1). Deterministic for a given uint32 seed.
export function hash2(x, z, seed)          // → uint32; inputs coerced with |0
export function hash3(x, y, z, seed)       // → uint32
export function rand2(x, z, seed)          // hash2 / 2^32 in [0,1)
export function rand3(x, y, z, seed)       // hash3 / 2^32 in [0,1)
export function lerp(a, b, t)
export function clamp(x, lo, hi)
export function smoothstep(e0, e1, x)      // Hermite; 0 for x<=e0, 1 for x>=e1
export function createNoise(seed)          // seed uint32 → NoiseFn
/** @typedef {{ noise2D(x,y):number, noise3D(x,y,z):number,
 *   fbm2D(x,y,octaves=4,lacunarity=2,gain=0.5):number, fbm3D(x,y,z,octaves=4,lacunarity=2,gain=0.5):number }} NoiseFn */
```
Algorithm: Gustavson simplex noise (public domain). Permutation table shuffled with `mulberry32(seed)`.
2D: `F2 = 0.5*(√3−1)`, `G2 = (3−√3)/6`, 12 gradients, result ×70; 3D: `F3 = 1/3`, `G3 = 1/6`, result ×32. Clamp to [−1,1].
fBm sums octaves with amplitude `gain^i`, frequency `lacunarity^i`, divided by Σ amplitude so range stays [−1,1].
Hash (additive pre-mix — an XOR pre-mix makes hash(x,z) === hash(-x,-z) for a third of all cells, mirroring trees/ores around spawn):
`h = (imul(x|0, 0x27d4eb2d) + imul(y|0, 0x165667b1) + imul(z|0, 0x9e3779b1) + (seed|0)) | 0; h = imul(h ^ (h>>>15), 0x85ebca6b);
h = imul(h ^ (h>>>13), 0xc2b2ae35); h ^= h>>>16; return h>>>0` (hash2 = hash3 with y = 0x5bd1e995).
Different seeds must give uncorrelated fields. Never call `Math.random`.

## 8. `src/worldgen.js`

```js
export function createWorldGen(seed)       // seed: string|number → WorldGen
/** @typedef {{ seed:number, getColumn(q,r):ColumnInfo, generateChunk(cq,cr):ChunkData }} WorldGen */
/** @typedef {{ height:number, biome:number, temperature:number, humidity:number }} ColumnInfo */
export const TREE_CELL = 6;
export const TREE_DENSITY = [0, 0, 0.06, 0.7, 0, 0.06, 0, 0];   // index = BIOME id
export const ORE_TABLE = [ /* see below */ ];
```
`seed` is normalised with `normalizeSeed`. Internal noise instances use derived seeds `hash3(seed, salt, 0, 0)`,
salts 1..8: `nCont, nDetail, nMount, nTemp, nHumid, nCaveA, nCaveB, nCavern`.

**Continuous noise is sampled at the cell's WORLD position** `(wx, wz) = hexToWorld(q, r)` so terrain, climate and caves are
isotropic (not sheared along the axial axes). **Discrete hashes** (bedrock, dirt depth, ores, trees) use the integer cell
coordinates `(q, r)`.

### 8.1 `getColumn(q, r)` — pure per column. All chunk decisions that must agree across chunk borders
(trees, spawn) depend ONLY on this function.
```
(wx, wz) = hexToWorld(q, r)
c    = nCont.fbm2D(wx/500, wz/500, 3)
d    = nDetail.fbm2D(wx/50, wz/50, 2)
mRaw = nMount.fbm2D(wx/250, wz/250, 2);  m = clamp((mRaw - 0.25) / 0.75, 0, 1)
T    = nTemp.fbm2D(wx/400 + 1000, wz/400, 2)
H    = nHumid.fbm2D(wx/400, wz/400 + 1000, 2)
isDesert = T > 0.35 && H < 0
height = clamp(round(66 + c*14 + d*(isDesert ? 2 : 4) + m*m*48), MIN_TERRAIN_HEIGHT, MAX_TERRAIN_HEIGHT)
biome  = height <= SEA_LEVEL-2 ? OCEAN : height <= SEA_LEVEL+2 ? BEACH : height >= 92 ? SNOWY_PEAKS
       : height >= 84 ? MOUNTAINS : T < -0.35 ? SNOWY : isDesert ? DESERT : H > 0.15 ? FOREST : PLAINS
return { height, biome, temperature: T, humidity: H }
```
### 8.2 `generateChunk(cq, cr)` → fresh `ChunkData` (never reuses arrays). Steps, in order:
1. **Columns.** For each `lq, lr`: `q = cq*16+lq, r = cr*16+lr`, `col = getColumn(q, r)`; `heights[ci] = col.height`,
   `biomes[ci] = col.biome` (`ci = columnIndex(lq, lr)`). Fill `y = 0..height`:
   - `y === 0` → BEDROCK; `y === 1` → BEDROCK if `rand3(q,1,r,seed) < 0.5`; `y === 2` → BEDROCK if `rand3(q,2,r,seed) < 0.15`.
   - top block (`y === height`) and filler (`height-fillerDepth <= y < height`) by biome:
     OCEAN: top/filler = `height >= 58 ? SAND : GRAVEL`, depth 3. BEACH: SAND, depth 3. PLAINS/FOREST: top GRASS_BLOCK,
     filler DIRT depth `3 + (hash2(q, r, seed) & 1)`. SNOWY: top SNOWY_GRASS, filler DIRT depth 3. DESERT: top SAND,
     filler SAND depth 3, then SANDSTONE for the next 3 blocks below the sand. MOUNTAINS: STONE everywhere.
     SNOWY_PEAKS: top SNOW_BLOCK, STONE below. Everything else STONE.
   - Then `y = height+1 .. SEA_LEVEL` → WATER (only when `height < SEA_LEVEL`).
2. **Caves.** For each column with `(wx, wz) = hexToWorld(q, r)`, `y = 6 .. height-4` (inclusive), skipping
   `y > SEA_LEVEL-12` when biome is OCEAN or BEACH: `a = nCaveA.noise3D(wx/40, y/28, wz/40)`,
   `b = nCaveB.noise3D(wx/40 + 300, y/28, wz/40 − 300)`, `taper = y < 12 ? (y-6)/6 : 1`. Carve (set AIR) if
   `|a| < 0.12*taper && |b| < 0.12*taper`, or if `y < 45 && nCavern.fbm3D(wx/70, y/50, wz/70, 2) > 0.55`. Never carve BEDROCK.
3. **Ores.** `ORE_TABLE = [ {id:COAL_ORE, attempts:18, minY:8, maxY:100, minSize:6, maxSize:10},
   {id:IRON_ORE, attempts:12, minY:4, maxY:60, minSize:4, maxSize:8}, {id:GOLD_ORE, attempts:3, minY:4, maxY:30, minSize:3, maxSize:6},
   {id:DIAMOND_ORE, attempts:1, minY:2, maxY:14, minSize:2, maxSize:5}, {id:GRAVEL, attempts:4, minY:8, maxY:70, minSize:10, maxSize:16},
   {id:DIRT, attempts:6, minY:8, maxY:90, minSize:10, maxSize:16} ]`.
   For table row `o` (index `oi`) and attempt `i`: `rng = mulberry32(hash3(cq, cr, oi*1000 + i, seed))`;
   origin `lq = floor(rng()*16), lr = floor(rng()*16), y = minY + floor(rng()*(maxY-minY+1))`; `size = minSize + floor(rng()*(maxSize-minSize+1))`;
   random walk `size` steps, each step `dir = floor(rng()*8)`: `0..5` → move to `HEX_DIRS[dir]`, `6` → `y+1`, `7` → `y−1`;
   at every visited cell inside this chunk with `0 <= y < WORLD_HEIGHT`, if the block is STONE set `o.id`.
4. **Trees.** For `kq = floorDiv(cq*16 - 3, TREE_CELL) .. floorDiv(cq*16 + 18, TREE_CELL)` and same for `kr`:
   `hsh = hash2(kq, kr, seed ^ 0x7ee5)`; `tq = kq*6 + 1 + (hsh & 3)`; `tr = kr*6 + 1 + ((hsh >>> 2) & 3)`;
   `trunk = 4 + ((hsh >>> 4) % 3)`; `roll = ((hsh >>> 8) & 0xffff) / 65536`; `col = getColumn(tq, tr)`.
   Valid iff `roll < TREE_DENSITY[col.biome] && col.height >= SEA_LEVEL + 2 && col.height + trunk + 2 < WORLD_HEIGHT`.
   Stamp (only cells inside this chunk; convert cell → local): with `base = col.height + 1`, `T = col.height + trunk`,
   `d = hexLength(dq, dr)` the hex distance from the trunk:
   OAK_LOG at `(tq, y, tr)` for `y = base..T` (overwrites anything); OAK_LEAVES where the cell is AIR at:
   `y ∈ {T-1, T}`: all `d <= 2` except the six ring-2 corners (`d === 2 && (dq === 0 || dr === 0 || dq + dr === 0)`) → 13 cells;
   `y = T+1`: `d <= 1` (7 cells); `y = T+2`: the trunk column plus the neighbours across side faces 0, 2, 4 (4 cells).
   Because caves never carve above `height-4` and ores only replace STONE, every chunk agrees on every tree.

Cost target: ≤ 8 ms per chunk in Node on this machine.

## 9. `src/world.js`

```js
export class World {
  constructor(opts)   // { seed: string|number, renderDistance?: number = RENDER_DISTANCE, edits?: EditsJSON,
                      //   worldGen?: WorldGen (tests inject a trivial one), now?: () => number (ms clock; default performance.now) }
  seed;               // normalised uint32
  renderDistance;     // hex distance in chunks
  worldGen;           // WorldGen
  chunks;             // Map<ChunkKey, Chunk>
  edits;              // Map<ChunkKey, Map<number, BlockId>>  (inner key = localIndex)
  origins;            // v0.8: Map<ChunkKey, Map<number, BlockId>> — each edited cell's id before its first edit (§9.2)
  editVersion = 0;    // incremented on every successful setBlock (autosave uses it)
  onChunkMesh   = (key, cq, cr, meshData) => {};   // assignable hook, called synchronously from update()
  onChunkUnload = (key) => {};                     // assignable hook
  onBlockChange = (q, y, r, prev, next) => {};     // assignable hook, called synchronously from setBlock ONLY, after the edit is
                                                   // recorded and chunks are dirtied; never from importEdits / applying saved edits
  onChunkGenerated = (cq, cr) => {};               // v0.8 assignable hook: end of _generate, after the chunk is registered and its
                                                   // saved edits are applied (block physics re-queues parked updates, re-seeds)
  get editCount()            // total recorded edit entries across all chunks (area commands budget against MAX_TOTAL_EDITS); O(1) (v0.8)
  peekBlock(q, y, r)         // v0.8: like getBlock but UNLOADED (255) for a cell in an unloaded chunk; AIR outside 0..127 and for NaN y
  hasEdit(q, y, r)           // v0.8: the cell has a recorded edit (loaded or not)
  originAt(q, y, r)          // v0.8: recorded origin of an edited cell, else its current id (UNLOADED when unknown)
  terrainHeightAt(q, r)      // v0.8: chunk.heights of the column (generated terrain height), −1 when not loaded
  isNaturalGround(q, y, r)   // v0.8: loaded && no edit && y ≤ terrainHeightAt && isSolid(block) — untouched terrain (§36)
  getBlock = (q, y, r) => BlockId;      // ARROW PROPERTY. CELL coords. AIR when y out of range or chunk not loaded. Never allocates.
  getChunkData = (cq, cr) => Chunk|null; // ARROW PROPERTY.
  getBlockAt(x, y, z)        // WORLD position convenience: getBlock(...worldToHex(x, z), floor(y)); AIR for non-finite input
  setBlock(q, y, r, id, lazy = false) // CELL coords. boolean: false if y out of range, id not an integer 0..255, chunk not loaded, or unchanged.
                             // On success: chunk.set, edits record (§9.2: origin on the first edit, deleted when written back to its
                             // origin), editVersion++, and marks dirty (lazily when `lazy`, §9.2) every LOADED chunk
                             // containing the cell or one of its 6 HEX_DIRS neighbours (dedupes to 1–4 chunks; 4 only for the
                             // index-space corner cells lq=15,lr=0 and lq=0,lr=15).
  getChunk(cq, cr)           // Chunk|undefined
  hasChunkAt(wx, wz)         // WORLD position → chunk of worldToHex loaded?   hasChunkAtCell(q, r) takes a cell
  isReadyAt(wx, wz)          // WORLD position: chunk exists, !dirty, meshed    isReadyAtCell(q, r) takes a cell
  get chunkCount()           // number of loaded chunks
  update(px, pz, budgetMs = BUILD_BUDGET_MS)  // WORLD position; streaming step; returns { generated, meshed, unloaded, pendingGen, pendingMesh }
                             // (all zero, nothing touched, when px/pz is not finite)
  findSpawn()                // Vec3 WORLD position: hex spiral from cell (0,0) in 4-cell steps (ring n visits the 6n cells at hex distance n,
                             // starting at n·HEX_DIRS[4] and walking HEX_DIRS[0..5]) until worldGen.getColumn(q, r) has height >= SEA_LEVEL+2
                             // and biome not OCEAN/BEACH; returns [x, height+1, z] with (x, z) = hexToWorld(q, r).
                             // Bounded: after 128 rings fall back to [0, max(getColumn(0,0).height, SEA_LEVEL)+1, 0]
  getSurfaceHeight(q, r)     // worldGen.getColumn(...).height (ignores edits)
  getBiome(q, r)             // biome id from worldGen.getColumn
  exportEdits()              // EditsJSON: { "cq,cr": [localIndex, id, localIndex, id, ...] }
  importEdits(editsJson)     // merge (last write wins); for loaded chunks also apply and mark dirty (+ neighbours)
  setRenderDistance(n)       // clamp 1..16, recompute ring offsets
  dispose()                  // remove all chunks, firing onChunkUnload for meshed ones
}
```
### 9.1 `update(px, pz, budgetMs)` (normative)
```
(pq, pr) = worldToHex(px, pz); pcq = floor(pq/16), pcr = floor(pr/16); start = now(); builds = 0
overBudget = () => builds >= MAX_BUILDS_PER_UPDATE || now() - start >= budgetMs
1. Unload every chunk with hexLength(cq-pcq, cr-pcr) > renderDistance + UNLOAD_RADIUS_EXTRA:
   chunks.delete(key); if chunk.meshed → onChunkUnload(key). (Edits stay in `edits`.)
2. Re-mesh edited chunks: every loaded chunk with dirty && meshed && all 6 hex neighbours loaded and NOT lazy → mesh now (ignores
   budget). v0.8: the ones that are lazy are sorted by squared world distance from (px, pz) to their centre cell
   `hexToWorld(cq·16+8, cr·16+8)` and meshed in that order until `now() − lazyStart ≥ LAZY_MESH_BUDGET_MS`, always at least one.
3. Walk RING_OFFSETS = all (dq,dr) with hexLength(dq,dr) <= renderDistance + DATA_RADIUS_EXTRA, sorted by hexNormSq(dq,dr)
   ascending (ties: dr then dq ascending). For each: cq = pcq+dq, cr = pcr+dr, chunk = chunks.get(key):
   if !chunk: data = worldGen.generateChunk(cq,cr); chunk = new Chunk(cq,cr,data); apply edits.get(key) (blocks[li] = id per pair);
              chunks.set(key, chunk); builds++; generated++; if overBudget() break
   if hexLength(dq,dr) <= renderDistance && chunk.dirty && !(chunk.meshed && chunk.lazy) && all 6 hex neighbours loaded:
              m = buildChunkMesh(cq, cr, this.getChunkData); chunk.dirty = false; chunk.meshed = true;
              onChunkMesh(key, cq, cr, m); builds++; meshed++; if overBudget() break
   pendingGen / pendingMesh = counts of remaining ring entries that still need work (computed cheaply at the end or as the walk proceeds);
   a meshed lazily-dirty chunk counts as pendingMesh (step 2 meshes it on a later call).
```
Guarantee: at least one build per call when work is pending (budget is checked after each build). With `budgetMs = Infinity`
and `MAX_BUILDS_PER_UPDATE` respected, repeated calls converge to `pendingGen === 0 && pendingMesh === 0`: `hexDiscCount(rd)`
meshed chunks and `hexDiscCount(rd + DATA_RADIUS_EXTRA)` loaded. Because a chunk is meshed only once its 6 hex neighbours
exist (the mesher never reads anything else), generation never invalidates an existing mesh.
Missing `performance` (Node < 16) → use `Date.now`. Tests pass `now: () => 0` and `budgetMs = Infinity`.
### 9.2 Origins, edit pruning and lazy re-meshing (v0.8, normative)
1. `setBlock` success: if the cell has no edit → add the edit, record `origins[key][li] = prev`, `editCount++`. If it has one and
   `id === origin` → delete the edit and the origin, `editCount--` (empty per-chunk maps are deleted). Otherwise update the edit.
   An edit without a recorded origin is never pruned.
2. `importEdits` into a LOADED chunk uses the same bookkeeping (a pair equal to the current block is skipped); into an unloaded
   chunk it only records the edit (no origin). `_generate` gives every recorded edit of the new chunk its origin (the generated
   id) and DROPS edits equal to the generated id, then fires `onChunkGenerated(cq, cr)`. Edits and origins survive unloading.
3. Lazy marks: for each loaded chunk to dirty, a non-lazy write sets `dirty = true, lazy = false`; a lazy write sets `dirty = true,
   lazy = true` only when the chunk was clean (non-lazy wins). Meshing clears both. Block physics, black-hole eats and explosions
   write lazily; the player, commands and runes do not.
4. `editCount` is a running count equal to Σ `edits` sizes at all times.

## 10. `src/mesher.js`

```js
export function buildChunkMesh(cq, cr, getChunkData)   // → ChunkMeshData { opaque, cutout, translucent } (null layer when 0 faces)
                                                        //   cells whose block is not isMeshed emit nothing (v0.7); neighbours still
                                                        //   apply shouldRenderFace against them (non-opaque → their faces render)
export function vertexAO(side1, side2, corner)          // (side1 && side2) ? 0 : 3 - (side1 + side2 + corner); args 0|1  (side faces)
export function hexCornerAO(sideA, sideB)               // 3 - (sideA + sideB)                                            (hex caps)
export function isTintedFace(id, face)                  // OAK_LEAVES: every face; GRASS_BLOCK: FACE_TOP only
export const BIOME_TINT                                 // [r,g,b] × 8 biomes, multiplied into tinted faces
export function createMeshBuilder(initialVertices = 1024) // growable buffer helper; ensure(vertices, indices), reset(), build()
export function buildCellMesh(id)                       // v0.8: ChunkMeshData of ONE fully exposed cell of `id` (plains tint, no AO), centred on
                                                        //   the origin (x/z around 0, y −0.5..0.5); fresh arrays; fallingRenderer caches per id
/** MeshData = { positions: Float32Array (3/vertex, chunk-LOCAL relative to chunkOrigin(cq, cr): x ∈ [−0.5, 24.5], y ∈ [0,128],
 *   z ∈ [−0.58, 13.86+0.58]), normals (3/vertex = FACE_NORMALS[f]), uvs (2/vertex), colors (3/vertex, 0..1),
 *   indices: Uint32Array (6 per side quad, 18 per hex cap), vertexCount, indexCount, faceCount } */
```
### 10.1 Padded volume (normative so tests agree)
`padded = Uint8Array(18*18*WORLD_HEIGHT)`, `pIndex(pq,py,pr) = (pq*18 + pr)*WORLD_HEIGHT + py`; local `(lq,ly,lr)` ↔ padded
`(lq+1, ly, lr+1)`. Fill: for `pq,pr ∈ [0,18)`: source chunk `(cq + floorDiv(pq-1,16), cr + floorDiv(pr-1,16))`, source local
`(mod(pq-1,16), mod(pr-1,16))`; if `getChunkData` returns null → zeros (AIR); else copy the whole column with `subarray`.
`getChunkData` is called for the centre and the 6 hex-adjacent chunks only — the index-space corners `(±1,±1)` are never
requested (nothing in the chunk is adjacent to them) and stay AIR. Lookup `P(pq,py,pr)`: `py < 0 → BEDROCK` (so y=0 bottoms
are culled), `py >= WORLD_HEIGHT → AIR`, else `padded[...]`. Reuse one module-level scratch buffer between calls (fill with 0 first).
The centre chunk's `biomes` array (if present, length ≥ 256) supplies the per-column tint; otherwise PLAINS.
### 10.2 Emission for block `a` at local `(lq,ly,lr)`, centre `C = (lq + lr/2, lr·√3/2)`, neighbour `Q` across face `f`
(`Q = P + HEX_DIRS[f]` for sides, `±1` in y for caps). Emit iff `shouldRenderFace(a, P(Q))` — except between the water family
(v0.8, §35.4): when `a` is water (`isWater`), its top face is emitted iff the cell above is NOT water and either its `topY < 1` (a lowered
surface leaves a gap, so it is drawn even under an opaque block) or `shouldRenderFace(a, above)` (a full-height cell under an
opaque block has no top face), its bottom face iff `!isWater(below) && shouldRenderFace(a, below)`, and a side face toward a
water neighbour `Q` iff `topY(Q) < topY(a)`, spanning only `bottomY = topY(Q) .. topY(a)` (2a) — `topY(Q)` by the same step 1 with Q's
own upper neighbour (one `waterTopY(id, above)` for both), so two full cells that are both covered draw nothing between them (before:
each took the other at 0.875 and both drew a strip, a honeycomb of coincident pairs under a glass floor over a pool).
1. `topY = isWater(a) && !isWater(P(above)) ? waterSurfaceHeight(a, P(above)) : 1` (WATER / FALL `WATER_SURFACE_HEIGHT`, FLOW_k
   `k/7` of it) — except that a FULL cell (WATER or WATER_FALL) under a block meshed as a full prism (`isMeshed(above)` and not AIR:
   stone, and also see-through glass, ice, leaves, a black hole) stays at 1, so a submerged see-through block shows no fake surface
   ledge (its top cap is drawn flush with that block's bottom face); only a free surface (AIR, or a block drawn by its own model:
   campfire) lowers a full cell. Flowing levels keep their own height everywhere. Applies to EVERY top vertex of that water cell:
   the top corners of all six side quads and the whole top hexagon sit at `ly + topY`. A block resting ON the surface leaves
   the full cell under it 0.125 above the open water around; that step is drawn by the water-to-water side strips (2a), so no
   dark band shows. (A rule that lowers the cell when the block above has no water beside it was tried and rejected: it brings
   the fake ledge back under every submerged structure three or more cells wide.)
2. **Side face `j`** (quad, 4 vertices, CCW from outside): `v0 = bottom corner j+1`, `v1 = bottom corner j`, `v2 = top corner j`,
   `v3 = top corner j+1` (so v0/v3 are the LEFT edge seen from outside, v1/v2 the RIGHT). Position `C + HEX_CORNERS[k]`,
   `y = ly` or `ly + topY`; normal `FACE_NORMALS[j]`. AO per vertex with `third` = the neighbour sharing that corner's vertical
   edge (`HEX_DIRS[j+1]` for corner j+1, `HEX_DIRS[j−1]` for corner j) and `dy = top ? +1 : −1`:
   `s1 = isOpaque(third, ly)`, `s2 = isOpaque(Q, ly+dy)`, `c = isOpaque(third, ly+dy)`; `ao = vertexAO(s1, s2, c)`.
   UV: `uMid = (u0+u1)/2`, `uHalf = (u1−u0)·HEX_SIZE/2` (texel density 1 tile per unit); left vertices `u = uMid − uHalf`,
   right `uMid + uHalf`; bottom `v = v1`, top `v = v0` (a lowered / partial water face cuts the window to its span: height t in the
   cell → `v = v1 − (v1 − v0)·t`; the bottom vertices sit at `ly + bottomY`, 0 unless 2a). Indices with `b` = vertexCount before the quad:
   if `ao0 + ao2 >= ao1 + ao3` push `b,b+1,b+2, b,b+2,b+3` else `b+1,b+2,b+3, b+1,b+3,b`.
3. **Cap faces** (`FACE_TOP`, `FACE_BOTTOM`): 7 vertices — the centre `C` first, then the six corners in order `0,5,4,3,2,1`
   for the top (CCW seen from +Y) and `0,1,2,3,4,5` for the bottom; normal `(0, ±1, 0)`; `y = ly + topY` (top) or `ly` (bottom).
   Corner `k` AO: the two side neighbours sharing corner k are `HEX_DIRS[k−1]` and `HEX_DIRS[k]`, sampled at `ly ± 1`:
   `ao = hexCornerAO(sA, sB)`. The centre vertex colour is the MEAN of the six corner colours.
   UV: corner `u = u0 + (u1−u0)·(0.5 ± TOP_UV_SCALE·dx)` (`+` for the top, `−` for the mirrored bottom),
   `v = v0 + (v1−v0)·(0.5 + TOP_UV_SCALE·dz)`; centre `(uMid, vMid)`. Indices: fan `(b, b+1+m, b+1+((m+1) mod 6))` for `m = 0..5`.
4. Colour per vertex: `tint · FACE_SHADE[f] · AO_CURVE[ao]` where `tint = BIOME_TINT[column biome]` when `isTintedFace(a, f)`,
   else `(1,1,1)`.
5. Append to layer `getRenderLayer(a)`.
Build with growable typed buffers; convert once at the end. Never throws; empty chunk → all three null.
Perf target: a real worldgen chunk in ≤ 25 ms in Node.

## 11. `src/raycast.js`

```js
export function raycastHex(getBlock, ox, oy, oz, dx, dy, dz, maxDistance, isHit = isTargetable)  // → RaycastHit|null
export const UNBOUNDED_ITERATION_CAP = 1 << 16;
/** RaycastHit = { q, y, r (integers), face: FaceIndex|-1, nx, ny, nz (unit outward normal of the entered face), distance, blockId } */
```
Direction normalised internally (zero/non-finite → null). Start cell `(q, r) = worldToHex(ox, oz)`, `y = floor(oy)`. If
`isHit(getBlock(q,y,r))` at the start → `{q,y,r, face:-1, nx:0,ny:0,nz:0, distance:0, blockId}`.
Each step computes the exit of the current prism from scratch: for every side `j` with `d·n_j > 1e-12`,
`t_j = (HEX_INRADIUS − (o − c)·n_j) / (d·n_j)` where `c = hexToWorld(q, r)`; top `t = (y+1−oy)/dy` if `dy > 0`, bottom
`t = (y−oy)/dy` if `dy < 0`. Exit through the smallest `t` (**ties → lowest face index**; sides before caps). Clamp
`t = max(t, tPrev)` (never walk backwards; never −0). If `t > maxDistance` → null. Step to the neighbour across the exit face;
entered face = `FACE_OPPOSITE[exit]`, normal = `FACE_NORMALS[entered]`. Return null early if `y < 0 && dy <= 0` or
`y >= WORLD_HEIGHT && dy >= 0`. If `isHit(getBlock(q,y,r))` → hit with `distance = t`. Iteration cap
`min(ceil(maxDistance*6)+6, UNBOUNDED_ITERATION_CAP = 65536)` — a finite `maxDistance` above ~10 921 is truncated rather than allowed to
spin (REACH is 5). Consecutive visited cells are always hex- or vertically adjacent.

## 12. `src/physics.js`

```js
export const PLAYER_RADIUS = PLAYER_WIDTH / 2;         // must be < HEX_INRADIUS (throws at import otherwise)
export function createPlayer(x, y, z)                 // PlayerState at feet position (WORLD); velocities 0; onGround false; flying false
export function stepPlayer(p, input, getBlock, dt)     // mutates p. dt clamped to MAX_FRAME_DT and split into ceil(dt/MAX_SUBSTEP_DT) equal substeps
export function getEyeHeight(p)                        // (p.sneaking && !p.flying) ? SNEAK_EYE_HEIGHT : EYE_HEIGHT
export function playerAABB(p, out = {})                // bounding box of the cylinder: ±PLAYER_RADIUS around (x,z), y..y+PLAYER_HEIGHT
export function playerIntersectsBlock(p, q, y, r)      // strict: hexCircleContact(cell centre, p.x, p.z, bodyRadius(p)) && p.y < y+1 && p.y+bodyHeight(p) > y
// v0.6 per-body sizes: every routine below reads bodyRadius(p) = p.radius ?? PLAYER_RADIUS and bodyHeight(p) = p.height ?? PLAYER_HEIGHT
// (including the substep collider; the chest sample is p.y + min(1.0, 0.6·height)), so a plain PlayerState behaves exactly as before.
export const MAX_BODY_RADIUS = 0.5                     // the 7-column collider is exact below HEX_SIZE (≈0.577)
export function createBody(x, y, z, { radius, height, mass = 1 })   // createPlayer + size; RangeError unless 0 < radius ≤ MAX_BODY_RADIUS, height, mass > 0
export function displaceBody(p, dx, dy, dz, getBlock)  // terrain-aware shove: moveHorizontal(dx, dz) then moveVertical(dy); a floor/ceiling hit
                                                       //   zeroes vy toward it (floor → onGround). → { hitWall, hitFloorOrCeiling }
// isFreeAt(getBlock, x, cy, z, radius = PLAYER_RADIUS, height = PLAYER_HEIGHT) and findFreeY(..., maxUp = 2, radius, height) take a size.
export function findStandingY(getBlock, x, z, fromY)   // in the cell column under WORLD (x,z): scan down from fromY for the first y where
                                                       // block(y-1) solid and blocks y, y+1 not solid; null if none / non-finite input
export function isFreeAt(getBlock, x, cy, z)           // cylinder with feet at (x, cy, z) overlaps no solid cell (7-column test)
export function findFreeY(getBlock, x, z, fromY, maxUp = 2) // first free feet height among fromY, fromY+1, …, fromY+maxUp; null if none
export function isUnderSurface(getBlock, q, py, r)     // v0.8 (§35.4): the point at height py in column (q, r) is below its cell's waterSurfaceHeight
export function isSwimWater(getBlock, q, y, r)         // v0.8 (§35.4): standing at y (or one step down) means swimming (≥ 2 deep / surface > WADE_DEPTH)
export function supportingCells(p, getBlock, out = [])  // [q,y,r] of the cells under the player's footprint whose cell at floor(p.y − 1e-3)
                                                       // is solid (empty when airborne); the step-on trigger is edge-triggered on this set
/** PlayerState = { x,y,z, vx,vy,vz, onGround, flying, sneaking, sprinting, inWater, headInWater, hitWall }
 *  PlayerInput = { forward: -1|0|1, strafe: -1|0|1, jump, sneak, sprint: boolean, yaw: number, pullX?, pullY?, pullZ?: number }
 *  pull* (v0.5, black holes) are accelerations in m/s², default 0, felt every substep in EVERY mode (§12.1 steps 2–3). Where
 *  velocity relaxes toward a target (horizontal always, vertical while flying) the pull moves the target by pull / GROUND_ACCEL,
 *  so it adds a drift of exactly pull / GROUND_ACCEL whatever h and accel are (the v0.5 rule, a raw pull·h, drifted pull·h/k:
 *  18 % more on the ground at 60 Hz and 5× more airborne, so hopping away from a hole was far worse than walking). Where vy is
 *  ballistic (falling, swimming) it is a plain acceleration: vy = max(vy + pullY·h, TERMINAL_VELOCITY) after the vertical rule. */
```
The player is a **vertical cylinder** of radius `PLAYER_RADIUS` and height `PLAYER_HEIGHT`. Because the radius is smaller than
a cell's inradius, the footprint can only overlap the cell containing `(x, z)` and its six neighbours; the collider examines
exactly those 7 columns (`gatherColumns`).
### 12.1 Substep of `h` seconds (normative)
```
1. Environment (v0.8 water surfaces, §35.4): (bq, br) = worldToHex(x, z); fy = floor(y+0.1); feet = getBlock(bq, fy, br)
   under(py) = isLiquid(cell at floor(py)) && py − floor(py) < waterSurfaceHeight(that cell, the cell above it)   // isUnderSurface
   inWater = (isLiquid(feet) && isSwimWater(getBlock, bq, fy, br)) || under(y + min(1.0, 0.6·height))
     — depth is measured over the floor of the feet column, so a body floating near the top of deep water still swims (keeps
     buoyancy and SWIM_EXIT_JUMP); a body standing in a film wades
   wading = isLiquid(feet) && !inWater;  headInWater = under(y + getEyeHeight(p))
   sneaking = input.sneak && !flying;  sprinting = input.sprint && input.forward > 0 && !sneaking
2. Horizontal: [fx,fz] = yawToForward(input.yaw); [rx,rz] = yawToRight(input.yaw)
   wx = fx*forward + rx*strafe; wz = fz*forward + rz*strafe; normalise (wx,wz) if its length > 1
   speed = flying ? (sprinting ? FLY_SPRINT_SPEED : FLY_SPEED) : sneaking ? SNEAK_SPEED : sprinting ? SPRINT_SPEED : WALK_SPEED
   if (inWater && !flying) speed *= WATER_SPEED_FACTOR; else if (wading && !flying) speed *= WADE_SPEED_FACTOR   // wading: no swim mode
   accel = (flying || onGround) ? GROUND_ACCEL : inWater ? WATER_ACCEL : AIR_ACCEL;  k = 1 - exp(-accel*h)
   vx += (wx*speed + pullX/GROUND_ACCEL - vx)*k;  vz += (wz*speed + pullZ/GROUND_ACCEL - vz)*k
3. Vertical:
   flying:  target = ((jump?1:0) - (sneak?1:0)) * FLY_VERTICAL_SPEED + pullY/GROUND_ACCEL;  vy += (target - vy) * (1 - exp(-GROUND_ACCEL*h))
   inWater: if jump: vy = hitWall ? SWIM_EXIT_JUMP : SWIM_UP_SPEED;  else vy = max(vy + WATER_GRAVITY*h, WATER_MAX_SINK)
   else:    if (jump && onGround) vy = JUMP_VELOCITY;  vy = max(vy + GRAVITY*h, TERMINAL_VELOCITY)
   not flying, pullY ≠ 0: vy = max(vy + pullY*h, TERMINAL_VELOCITY)
4. Move, vertical then horizontal; before moving: onGround = false, hitWall = false
   moveVertical(vy*h): collision moving down → onGround = true; any collision → vy = 0
   moveHorizontal(vx*h, vz*h): any collision → hitWall = true (velocity into each wall removed, tangential kept)
   If flying and a downward collision happened → flying = false (landing ends flight).
```
`moveVertical(delta)`: `y += delta`; for each of the 7 columns whose hexagon STRICTLY overlaps the footprint circle
(`hexCircleContact`), for `cy = floor(y) .. ceil(y+PLAYER_HEIGHT)-1`, collect solid cells. If any: `delta > 0` →
`y = min(cellBottom) − PLAYER_HEIGHT − COLLISION_EPS`; `delta < 0` → `y = max(cellTop) + COLLISION_EPS`.
`moveHorizontal(dx, dz)`: remember `(x0, z0)`; `x += dx; z += dz`; up to 8 passes: among the 7 columns with a solid cell in the
height range, find the DEEPEST `hexCircleContact` and push the player out along its `(nx, nz)` by `depth + COLLISION_EPS`; remove the
velocity component into that normal (`if v·n < 0: v −= (v·n) n`). Stop as soon as nothing overlaps. If something STILL overlaps
after the 8th push (two near-antiparallel contacts), **refuse the move**: `x = x0, z = z0, vx = vz = 0`, hitWall. Every move
therefore ends overlap-free, which is what lets `moveVertical` treat any overlapping cell as one the sweep crossed. Non-finite
state → reset velocities to 0 and `console.warn` once. Sneak edge-prevention is NOT implemented.

## 13. `src/daynight.js`

```js
export const KEYFRAMES = [ /* from docs/SPEC-gameplay.md §6 table: { t, zenith, horizon, fog, sunColor, sun, amb, daylight, stars } with colours as [r,g,b] 0..1 */ ];
export function advanceTime(time, dt, dayLengthSeconds = DAY_LENGTH_SECONDS)   // (time + dt/dayLength) mod 1
export function computeSky(time)          // → SkyState (pure; linear interpolation between keyframes, wrapping 1 → 0)
export function formatTime(time)          // "HH:MM" (0.25 → "06:00")
export function sunDirection(time)        // Vec3 unit: θ = (time-0.25)*2π; normalize(cos θ, sin θ, 0.25)  (rises at +X)
/** SkyState = { time, isDay (0.25 <= t < 0.75), sunDir (toward sun by day, toward moon = -sun by night), sunColor, sunIntensity,
 *   hemiIntensity (= amb), zenithColor, horizonColor, fogColor, daylight (0..1), stars (0..1) } */
```
Keyframe values: use the table in `docs/SPEC-gameplay.md` §6 verbatim (`sun` → `sunIntensity`, `amb` → `hemiIntensity`).
Invariants: intensities ≥ 0; every colour channel in [0,1]; `computeSky(0)` equals `computeSky(1)`; continuous in `t`.

## 14. `src/storage.js`

```js
export const SAVE_KEY = 'caelancraft:v2:save';
export const SAVE_VERSION = 2;                      // v2: edits are keyed by hex (q, r) chunks; v1 cube saves are not loadable
export function serializeSave(data)                 // SaveData → JSON string (keys in stable order)
export function deserializeSave(text)               // string → SaveData|null (null on parse error, wrong version, missing/invalid fields)
export function saveGame(data, storage = globalThis.localStorage)   // boolean; false when storage missing or setItem throws
export function loadGame(storage = globalThis.localStorage)         // SaveData|null
export function hasSave(storage = globalThis.localStorage)          // boolean
export function clearSave(storage = globalThis.localStorage)        // void
/** SaveData = { version: 2, seed: number, time: number, day: number, player: {x,y,z (WORLD),yaw,pitch,flying}, hotbar: number[9],
 *   selected: number, edits: EditsJSON, runes?: RunesJSON, pigs?: PigJSON[], physics?: PhysicsSwitches }
 *   EditsJSON = { "cq,cr": [localIndex, id, localIndex, id, ...] } */
```
`physics` (v0.8) is OPTIONAL: `{ falling, water, collapse, explosions }` booleans. `serializeSave` writes it whenever
`data.physics != null`, canonicalised by `normalizePhysicsSwitches(raw)` (exactly these four keys in this order; anything not
`=== false` is on). `deserializeSave` keeps it when it is a plain object (non-boolean switches warn `physics.<name>: not a boolean,
treated as on`); a non-object is dropped with the warning `physics: not an object, ignored`. **Absent means the world was saved
before v0.8**: main then starts it with collapse OFF (§33.8). Exports `PHYSICS_SWITCH_NAMES`, `DEFAULT_PHYSICS_SWITCHES`.
`runes` (v0.3) is OPTIONAL and the version stays 2: `serializeSave` writes it only when `runes.normalizeRunesJSON(data.runes)` is
non-empty (keys sorted by (q, y, r), non-default fields only, so untouched worlds serialise byte-identically to before);
`deserializeSave` validates it with `runes.validateRunesJSON(raw.runes, edits)` — malformed keys, non-object entries, entries whose
cell is not recorded as `RUNE_BLOCK` in the repaired `edits` (orphans) are dropped with warnings — and keeps the field only when
non-empty. A non-object `runes` is ignored with a warning, never a null save.
Validation on load: each edits entry must be an even-length array of integers with `0 <= localIndex < CHUNK_VOLUME` and
`0 <= id <= 255`; invalid pairs are dropped (count them in a `warnings` array attached as a non-enumerable property is optional).
`hotbar` must be 9 integers, `selected` 0..8, else defaults.

## 15. `src/tiles.js` (pure pixel painters)

```js
export const TILE_NAMES = { 0:'stone', 1:'dirt', ..., 26:'wool_red', 27:'rune', 255:'missing' };   // matches TILE in blocks.js
export function paintTile(tile)          // → Uint8ClampedArray(16*16*4), RGBA, idx = (y*16 + x)*4. Deterministic. Unknown tile → 'missing' checker.
export function averageColor(tile)       // → [r,g,b] 0..255 mean over pixels with alpha >= 128
export function createTilePainters()     // → Map<tile, () => Uint8ClampedArray> (optional convenience)
```
Recipe 27 `rune` (v0.3): dark slate `0x2a2633` + noise 6, a pointy-top hexagon outline of radius 6 around (7.5, 7.5) in `0x7be8ff`
with a `0x355a6b` halo one pixel outward, spokes to corners 0/2/4 in `0x5fc8e8`, and a 2×2 centre dot `0xd8f8ff`; alpha 255.
v0.8 recipes 75 `barrel_side` / 76 `barrel_top` (tiles.js comments are normative; original art, alpha 255): four wooden staves
with dark seams, two dark iron bands with rivets on rows 1–3 and 12–14, and a red pointy-top hazard hexagon with a pale
exclamation mark between them; the lid is horizontal planks inside a dark iron rim, a fuse socket in the middle and a short fuse
whose tip burns yellow-orange.
v0.4 recipes 28–71 live in tiles.js (its comments are normative): spruce/birch reuse the oak plank, bark, log-end and leaves layouts
in new colours (birch bark is its own recipe); mossy cobblestone / stone bricks paint the base tile with ITS seed, then moss clumps;
storage blocks share a bevelled-plate recipe; honeycomb is a small hex-cell Voronoi; wool 58–71 use the white/red weave. Alpha:
spruce/birch leaves have oak-style ~22% holes, ICE is alpha 200 everywhere, all other v0.4 tiles alpha 255.
Recipes: `docs/SPEC-gameplay.md` §2.3–§2.4 verbatim, including the alpha rules (water alpha 178 everywhere; glass interior
alpha 0 with opaque frame; leaves ~22% alpha-0 holes; everything else alpha 255). Use private copies of `mulberry32` and
`fnv1a` (do not import noise.js). `paintTile` never depends on the world seed.

## 16. `src/atlas.js` (DOM + three)

```js
export function createAtlasCanvas()                        // 256×256 canvas; every id in TILE_IDS painted via paintTile at its tile origin
export function createAtlasTexture(canvas)                 // THREE.CanvasTexture: magFilter = minFilter = NearestFilter, generateMipmaps = false,
                                                           //   flipY = false, colorSpace = SRGBColorSpace, wrapS/T = ClampToEdgeWrapping, needsUpdate = true
export function drawBlockIcon(ctx, atlasCanvas, blockId, size)   // hexagonal-PRISM icon (see below) scaled to size×size at (0,0); AIR → blank
export function makeBlockIconCanvas(atlasCanvas, blockId, size)  // new canvas with the icon
export function iconTopCorner(k)                           // screen position of top corner k on the 32×32 reference canvas
export function makeTiledBackgroundDataURL(atlasCanvas, tile, repeats = 4)   // PNG data URL of tile repeated repeats×repeats
export function drawTitleLogo(logoCanvas, atlasCanvas)     // "Caelancraft" stone-pattern text per SPEC-gameplay §5.3
export function makeSunCanvas()                            // 32×32 per §2.5
export function makeMoonCanvas()
```
Icon (replaces SPEC-gameplay §2.5's cube): on the 32×32 reference canvas the top hexagon's corner `k` projects to
`(16 + 26·dx_k, 9 + 8·dz_k / HEX_SIZE)` → `k0 (29,5) k1 (29,13) k2 (16,17) k3 (3,13) k4 (3,5) k5 (16,1)`; the two front sides
(SW = face 2 on the left, corners 3→2, shade 0.2; SE = face 1 on the right, corners 2→1, shade 0.4) are parallelograms 14 px tall
below their top edge, drawn with `setTransform` from the 16×16 tile; the top tile is drawn over the hexagon's bounding box
(x 3..29, y 1..17) clipped to the hexagon. Shades use `source-atop` so transparent texels stay transparent.

## 17. `src/renderer.js` (three)

```js
export function createRenderer(canvas, atlasTexture, opts = {})   // opts: { sunCanvas?, moonCanvas?, renderDistance? }
export function fogRangeForRenderDistance(chunks)   // far = max(CHUNK_RING_INRADIUS, (chunks + FOG_FAR_CHUNK_MARGIN) * CHUNK_RING_INRADIUS), near = far * 0.55
/** Renderer = {
 *  three: { renderer, scene, camera },
 *  setChunkMesh(key, cq, cr, meshData: ChunkMeshData),  // replaces existing meshes for key; null layers → no mesh. Geometry from typed arrays
 *                                                       //   (index count = meshData.indexCount), mesh.position = (chunkOrigin(cq, cr)[0], 0, chunkOrigin(cq, cr)[1]),
 *                                                       //   matrixAutoUpdate=false + updateMatrix(), computeBoundingSphere()
 *  removeChunkMesh(key),                                // no-op if unknown; scene.remove + geometry.dispose() (never dispose shared materials)
 *  setCamera(x, y, z, yaw, pitch),                      // eye position (WORLD); rotation.order 'YXZ'; rotation.set(pitch, yaw, 0)
 *  setFov(fov),                                         // updates projection when changed
 *  setHighlight(hit: RaycastHit|null),                  // black wireframe HEX PRISM (EdgesGeometry of CylinderGeometry(HEX_SIZE·1.002, HEX_SIZE·1.002, 1.002, 6))
 *                                                       //   at (hexToWorld(hit.q, hit.r), hit.y + 0.5); hidden when null
 *  setSky(sky: SkyState),                               // lights, sky dome (gradient + sun glow), fog colours
 *  setUnderwater(on),                                   // fog near 1 / far 22 colour #204A8C when on; normal fog otherwise
 *  setRenderDistance(chunks),                           // fog range per fogRangeForRenderDistance
 *  resize(width, height),
 *  render(),
 *  getStats(),                                          // { chunkMeshes, triangles, drawCalls, geometries }
 *  onContextRestored,                                   // assignable hook: fired after a WebGL context restore once every chunk mesh was dropped
 *  dispose() } */
```
Wiring: `new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })` (MSAA keeps the many hex edges
clean); `setPixelRatio(min(devicePixelRatio, MAX_PIXEL_RATIO))`; `setSize(w, h, false)`. Leave `outputColorSpace` default.
Three shared materials: `opaque = MeshLambertMaterial({ map, vertexColors: true })`, `cutout = MeshLambertMaterial({ map, vertexColors: true,
alphaTest: 0.5, side: DoubleSide })`, `translucent = MeshLambertMaterial({ map, vertexColors: true, transparent: true, depthWrite: false,
side: DoubleSide })` (renderOrder 1). Lights: `DirectionalLight` (position = sunDir*200, target origin), `HemisphereLight(horizon, ground)`.
`setSky`: `dir.intensity = sunIntensity`, `dir.color.setRGB(...sunColor, SRGBColorSpace)`, `hemi.intensity = hemiIntensity`, fog/background
via `setRGB(..., SRGBColorSpace)`. Sky: `SphereGeometry(500,16,8)` BackSide dome following the camera with uniforms `uZenith, uHorizon,
uSunDir (true sun direction), uSunColor, uGlow (= SKY_GLOW · daylight)`; fragment = `mix(zenith, horizon, (1−h)³) + sunColor·glow·(0.35·s⁸ + 0.5·s⁶⁴)`
with `s = max(dot(dir, sunDir), 0)`, then `#include <colorspace_fragment>`; `fog: false`, `depthWrite: false`, `renderOrder -3`.
Sun/moon sprites: `depthTest:false / depthWrite:false / fog:false / renderOrder −1`, `transparent: false, alphaTest: 0.5` so they render in the
OPAQUE pass before terrain, which then overdraws them. Stars per §6. Fog: `new Fog(color, near, far)`.
Camera: `PerspectiveCamera(FOV, w/h, CAMERA_NEAR, CAMERA_FAR)`. Stats from `renderer.info`.

## 18. `src/controls.js` (DOM)

```js
export function createControls(canvas, doc = document)   // → Controls
/** Controls = {
 *  yaw, pitch,                       // radians, mutable (main restores from save); pitch clamped ±PITCH_LIMIT
 *  locked,                           // doc.pointerLockElement === canvas
 *  lock(), unlock(),                 // requestPointerLock / exitPointerLock; errors swallowed
 *  isDown(code),                     // KeyboardEvent.code
 *  consumePressed(code),             // true once per keydown edge (queued even if consumed later in the same frame)
 *  consumeMouse(),                   // { left, right, middle (held), leftPressed, rightPressed, middlePressed (edges), wheel (integer notches, +1 = scrolled down) }; edges/wheel reset
 *  consumeFlyToggle(),               // true once when Space was double-tapped within DOUBLE_TAP_SPACE_MS or KeyF pressed
 *  isSprinting(),                    // W double-tapped within DOUBLE_TAP_MS and still held
 *  getInput(),                       // PlayerInput: forward (W/ArrowUp = +1, S/ArrowDown = -1), strafe (D/ArrowRight = +1, A/ArrowLeft = -1),
 *                                    //   jump = Space, sneak = ShiftLeft|ShiftRight, sprint = isSprinting(), yaw
 *  onLockChange: (locked) => {},     // assignable
 *  setEnabled(on),                   // when false, game keys are ignored and state cleared (menus open)
 *  dispose() } */
```
Mouse look only while locked: `yaw -= movementX * MOUSE_SENSITIVITY; pitch -= movementY * MOUSE_SENSITIVITY`. Listen on `doc` for
`mousemove, keydown, keyup, pointerlockchange`, on `canvas` for `mousedown, mouseup, wheel ({passive:true}), contextmenu (preventDefault)`.
Clear held keys on unlock and on `window blur`. `keydown` for game keys calls `preventDefault()` while locked (Space, Tab, F3, digits, WASD, Shift,
E, F, M, T, R, Slash). A keydown whose `key === '/'` but whose code is not `Slash` (DE: Shift+7 = Digit7, numpad divide) queues a synthetic
`Slash` edge INSTEAD of its physical code, so typing `/` never also selects a hotbar slot.
Digit keys 1–9 are read by main via `consumePressed('Digit1')`. Do not bind Ctrl.

## 19. `src/hud.js` (DOM)

```js
export function createHUD(doc, atlasCanvas)   // binds to the ids in index.html (#hud, #crosshair, #hotbar, #block-toast, #save-toast, #debug-overlay, #underwater-overlay, #error-banner,
                                              //   #target-hint, #chat-log)
/** HUD = {
 *  setHotbar(ids: number[9], selected),   // redraws slot icons (drawBlockIcon at 32px; AIR → blank) and selection
 *  setSelected(i),
 *  showBlockToast(text),                   // 1.5 s then .fade 0.3 s then .hidden; restarts timer
 *  setDebugText(text), setDebugVisible(on), toggleDebug(), isDebugVisible(),
 *  setUnderwater(on),
 *  showSaveToast(text, isError = false),   // 1.5 s
 *  showError(text),                        // appends a line to #error-banner and unhides it
 *  setPickerOpen(on),                      // toggles #hud.picker-open
 *  setTargetHint(text|null),               // persistent line under the crosshair (#target-hint); null hides it; DOM touched only on change
 *  addChatLine(text, isError = false),     // #chat-log: last CHAT_LINES lines, each fades after CHAT_LINE_MS (multi-line text is split)
 *  onSlotClick: (slot) => {},              // assignable; fired when a hotbar slot is clicked (only while picker open)
 *  dispose() } */
```

## 20. `src/menus.js` (DOM)

```js
export const SPLASHES = [ /* 18 strings from SPEC-gameplay §5.4 */ ];
export function createMenus(doc, atlasCanvas, callbacks)
/** callbacks = { onNewWorld(seedText: string), onContinue(), onResume(), onSave(), onStopRunes(), onQuit(), onClickToPlay(), onPickBlock(blockId, slot|null), onPickerClose(),
 *              onPhysicsToggle(name) (v0.8: 'falling'|'water'|'collapse'|'explosions'), onUndoPhysics() (v0.8) }
 *  (#btn-stop-runes "Stop All Rune Scripts" in the pause menu fires onStopRunes; CONTROLS_SHEET lists T, /, R and Shift+R)
 *  Menus = {
 *   showTitle(hasSave), hideTitle(),        // sets a random splash, dirt background (makeTiledBackgroundDataURL DIRT), draws the logo, renders the controls sheet, enables #btn-continue iff hasSave
 *   showLoading(done, total), hideLoading(),
 *   showClickToPlay(), hideClickToPlay(),
 *   showPause(seed, physics?), hidePause(),        // v0.8 physics = PhysicsMenuState { switches, canUndo, undoKind? } refreshes the row first
 *   setPhysicsState(physics),               // v0.8: the Physics row (#btn-phys-falling|water|collapse|explosions: "<Label>: ON|OFF", class
 *                                           //   `off`, aria-pressed) and #btn-undo-physics (undoButtonLabel(canUndo, kind); disabled when !canUndo)
 *   showPicker(hotbar, selected), hidePicker(), isPickerOpen(),   // scrollable grid of PICKER_ORDER icons (64px canvases shown at 52px); click → onPickBlock(id, null); Digit1-9 while hovering → onPickBlock(id, slot)
 *                                           // styles.css: .picker-panel is a border-box flex column with max-height max(180px, calc(100vh − 8vh − 72px))
 *                                           //   and overflow-y auto; only #picker-grid (min-height 64px = one row, flex 0 1 auto, max-height 420px)
 *                                           //   shrinks and scrolls. At viewport heights ≥ 274px the panel ends above the hotbar (bottom 60px), which
 *                                           //   stays visible and clickable. Below that the panel stays 180px (chrome with a two-line hint, 116px, plus
 *                                           //   one row) so a block can always be picked, and only then overlaps the hotbar; if the hint wraps further
 *                                           //   (very narrow too), the panel scrolls
 *   getSeedInput(),                         // text of #seed-input
 *   dispose() } */
```
New World with an existing save must `confirm("This will delete your saved world. Continue?")` before calling `onNewWorld`.
v0.8 pause menu (index.html, below "Stop All Rune Scripts"): `#pause-physics.physics-row` = label "Physics" + four `.mc-button.toggle`
buttons, then `#btn-undo-physics`. CONTROLS_SHEET row R: "Run a Rune Block · light a Blast Barrel".

## 21. `src/audio.js` (WebAudio, optional feel)

```js
export function createAudio()   // → Audio; everything is a no-op when AudioContext is unavailable
/** Audio = { resume() (call on first user gesture), playBreak(soundGroup), playPlace(soundGroup), playClick(), setMuted(b), toggleMuted() → boolean, get muted,
 *   playOink(v), playSqueal(v), playCrackle(v), playThud(v) (v0.8: sine 110 → 45 Hz 160 ms + 500 Hz noise knock),
 *   playSplash(v) (v0.8: 0.35 s 1.6 kHz noise wash + two rising blips),
 *   playBoom(v) (v0.8 §37: sine thump 72 → 26 Hz 1.1 s + 0.9 s 420 Hz noise body + slowed 150 Hz rumble from +0.12 s + 60 ms 3.2 kHz crack),
 *   playHiss(v) (0.3 s 7 kHz noise breath), playFizzle(v) (0.45 s 2.5 kHz noise wash over a sine sagging 700 → 180 Hz),
 *   playCreak(v) (§36, below) } — volume v in 0..1, every sound scales linearly with it. main calls the physics sounds (§33.7)
 *   through PhysicsHooks.sound. */
```
Synthesis per SPEC-gameplay §9.
v0.8 trees: `playCreak(v)` (a tree starts to topple, §36.5.3): a 0.6 s sawtooth 85 → 135 → 60 Hz through a 700 Hz lowpass plus a 0.25 s
1.2 kHz noise rasp. (The explosives branch also wrote a `playCreak`; the merge kept this one, §38.1.2.)

## 22. `src/diagnostics.js` (DOM)

```js
export function parseParams(search = location.search)   // → Params { seed: string|null, rd: number|null (1..16), smoke, autoplay, nosave, debug, fly: boolean, time: number|null,
                                                         //            yaw: number|null (degrees), pitch: number|null (degrees, ±89.9), ui: 'console'|'editor'|null }
export function installErrorCapture(win, onError)        // window 'error' + 'unhandledrejection' → onError({message, stack})
export function installDebugHandle(win, game)            // win.__caelancraft = { version, ready:false, seed, world, player, controls, renderer, stats, errors:[], smoke:null,
                                                         //   getBlock(x,y,z) / setBlock(x,y,z,id) over WORLD positions (cell derived with worldToHex), getCell(x,z) → [q,r],
                                                         //   runCommand(line) → {ok, message}|null, runes (RuneStore), runner (RuneRunner|null), teleport, setTime,
                                                         //   v0.8: physics (BlockPhysics|null, refreshed like world), stepFrame(dt) (one synchronous simulation +
                                                         //   render step, for screenshot drivers under a virtual-time budget) }
export function updateDebugHandle(win, stats)            // refresh stats + ready flag (called by main every ~250 ms)
export function buildDebugText(game, stats)              // the F3 text block: XYZ (world), Cell (q y r) + chunk/local, facing, biome/seed, chunks,
                                                         //   target cell + face name + the cell's world centre (x z), time, mode; v0.8: a last line
                                                         //   `Physics: [PAUSED] queued N falling N tumbling N tick X ms [off: …]` when game.physics exists
export function runSmokeTest(game, win = window)         // Promise<SmokeResult>; drives the sequence in docs/PLAN-build.md §4 (hex cells: hit.q/y/r, faceNeighbor for the
                                                         //   placement target, world.isReadyAtCell) plus step 9b: a rune block placed by `setblock`, scripted via game.runes,
                                                         //   triggered by `run`, its `setblock @ @1 @ stone` observed, then cleaned up; sets win.__caelancraft.smoke, console.log('SMOKE_OK'|'SMOKE_FAIL', JSON),
                                                         //   writes #smoke-result (created if missing) and a green/red banner
/** GameContext (types.js) = { world, player, controls, renderer, hud, getTime(), setTime(t), getHit(), breakTargeted() → boolean, placeSelected() → boolean,
 *   teleport(x,y,z), setLook(yaw,pitch), getState() → 'title'|'loading'|'clickToPlay'|'playing'|'paused'|'picker'|'console'|'editor', stepFrame?(dt),
 *   runCommand?(line), runes?, runner? } */
```

## 23. `src/main.js` (glue; owns the game loop)

Boot: `params = parseParams()`; `save = params.nosave ? null : loadGame()`; DOM handles; `atlasCanvas`, `atlasTexture`, `renderer`, `hud`, `menus`, `controls`, `audio`.
State machine: `title → loading → clickToPlay → playing ⇄ paused`, `playing ⇄ picker`, `playing ⇄ console`, `playing ⇄ editor`.
Console/editor are modal like the picker: `setState` BEFORE `controls.unlock()`, controls disabled, simulation frozen (the rune runner too),
rendering continues. Closing any modal goes through `enterPlayingFromModal()`: `enterPlaying()` then, if the pointer lock is not back after
`RELOCK_CHECK_MS` (Esc is not a user activation, so the request may be refused), the click-to-play overlay is shown instead of a dead playing state.
- **Title**: `menus.showTitle(hasSave)`. New World → seed from input (`normalizeSeed` on trimmed text; empty → random `Math.floor(Math.random()*2**31)`),
  clear save (if not nosave), start. Continue → start with save. `params.autoplay || params.smoke` → skip title (use `params.seed ?? save?.seed ?? random`).
- **Loading**: `world = new World({ seed, renderDistance: params.rd ?? RENDER_DISTANCE, edits: save?.edits })`; `world.onChunkMesh = renderer.setChunkMesh;
  world.onChunkUnload = renderer.removeChunkMesh`; spawn = save?.player ?? world.findSpawn() (WORLD position); each frame `world.update(spawn.x, spawn.z, LOADING_BUDGET_MS)`,
  show progress = meshed chunks within HEX distance `min(2, rd)` of the spawn chunk out of `hexDiscCount(that radius)` (19 by default);
  when `world.isReadyAt(spawn.x, spawn.z)` → create player (`createPlayer`, or restore), `controls.yaw = save?.player.yaw ?? Math.PI` (face +Z),
  then `clickToPlay` (or straight to `playing` when autoplay/smoke).
- **Playing** loop (`requestAnimationFrame` timestamp; `dt = min((t - last)/1000, MAX_FRAME_DT)`): `input = controls.getInput()`; handle
  `consumeFlyToggle()` → `player.flying = !player.flying; player.vy = 0`; digits/wheel → hotbar; `KeyE` → picker; `F3` → debug; `KeyM` → mute;
  mouse edges/holds → break (repeat `BREAK_REPEAT_S`) / place (repeat `PLACE_REPEAT_S`) / pick; `if (world.hasChunkAt(player.x, player.z)) stepPlayer(...)`;
  `time = advanceTime(time, dt)` (frozen when `params.time != null`); **`runner.update(dt)`** (rune scripts: after physics, before
  streaming, so their edits re-mesh this frame); `world.update(player.x, player.z)`; eye/dir/`raycastHex` (`REACH`);
  Keys: `KeyT` → console (empty), `Slash` → console prefilled `/`; `KeyR` → `interactTarget()` (rune block targeted: `runner.trigger(key,
  'interact')`, or a chat line explaining why not), `Shift+R` → `editTarget()` (opens the editor; `ensure` creates the default entry);
  placing a RUNE_BLOCK opens its editor at once. `hud.setTargetHint` each frame: `[label · ]R run · Shift+R edit` (variants for disabled /
  no Interact trigger).
  `renderer.setCamera/setFov(sprinting ? SPRINT_FOV : FOV, smoothed)/setHighlight/setSky/setUnderwater`; HUD; `renderer.render()`; stats every 250 ms.
- **Paused**: entered when pointer lock is lost while playing (and not opening the picker); simulation and clock freeze; keep rendering. Resume re-locks.
- Break rule: `hit && isBreakable(hit.blockId)` → `world.setBlock(hit.q, hit.y, hit.r, AIR)`; `audio.playBreak(group)`. Place rule: `hit && hit.face >= 0`;
  target `(tq, ty, tr) = faceNeighbor(hit.q, hit.y, hit.r, hit.face)`; require `inHeightRange(ty)`, `isReplaceable(world.getBlock(tq,ty,tr))`, and
  `!(isSolid(sel) && playerIntersectsBlock(player, tq,ty,tr))`; `audio.playPlace`.
  Pick (middle): if `hit` and placeable: select the slot containing it, else assign to the selected slot.
- Autosave every `AUTOSAVE_INTERVAL_S` when `world.editVersion` or `runeStore.version` changed or the player moved, plus on `pagehide`,
  `visibilitychange(hidden)`, pause, Save, Quit. Skipped when `params.nosave`. `buildSaveData` includes `runes: runeStore.export()`.
- Runes lifecycle in main: ONE `RuneStore` for the session; `startLoading` sets `world.onBlockChange = onBlockChanged` (RUNE_BLOCK appears →
  `store.ensure`; RUNE_BLOCK disappears → `runner.cancel(key)`, `store.delete(key)`, close the editor if it shows that rune), resets the runner
  and calls `runeStore.replaceAll(save.runes)`; `finishLoading` builds the `CommandContext` (§26.3), creates the `RuneRunner`, wires
  `runner.onLog → logLine` (console + chat) and `runner.onTrigger` (click sound for interact/step), and `runner.seedStep()`; `quitToTitle` /
  `dispose` reset the runner and clear the store. `game.teleport` also calls `runner.seedStep()` (arriving is not stepping on). The pause menu's
  "Stop All Rune Scripts" calls `runner.stopAll()`. `game.runCommand(line)`, `game.runes`, `game.runner` are exposed for diagnostics.
- `?ui=console|editor|picker` (screenshot aid, autoplay only, ignored under `?smoke=1`; use with `?nosave=1`): after entering playing, `showDebugUi()` opens the console
  with `help` printed, opens the block picker (`picker`, no world writes), or runs `setblock q y r rune_block` three cells ahead, stores a sample rune (label "lift", stepOn + chain) and opens
  its editor — i.e. it WRITES to the world.
- The relock fallback (click-to-play after a refused lock) and `saveOnLeave` both save in any state that has a player, and `saveOnLeave`
  first flushes an open editor's fields into the store, so edits made in a modal are never lost when the page is left. A pointer lock that
  arrives while in click-to-play (a late grant of the modal-close request) enters playing directly. Modal keys (E, T, /) are consumed before
  the hotbar digits each frame. The editor's "Enabled" switch turned off cancels the rune's running script, like `rune q y r off`.
- **Block physics (v0.8, §33–§37).** `startLoading` creates ONE `BlockPhysics(world, physicsHooks)` right after the World (before any
  chunk generates), sets `world.onChunkGenerated → blockPhysics.onChunkGenerated`, and imports the save's switches — a restored save
  WITHOUT a `physics` field gets `importSwitches({ collapse: false })` and, once playable, the chat line OLD_WORLD_PHYSICS_NOTE
  ("New: block physics! Collapse is off for this older world — turn it on in Esc → Physics"); new worlds start all on.
  `onBlockChanged` forwards every change to `blockPhysics.onBlockChange` LAST (after black holes, campfires, runes). Black-hole eats
  write lazily. physicsHooks: `say` → logLine; `areaJobsActive` → `runner.hasActiveJobs()`; `bodies` → [player, pigs in loaded
  chunks]; `player`; `sound(name, x, y, z, v)` → `audio['play' + Name]` when it exists (`break:<group>` → playBreak), volume ·
  (1 − d/range) with range BOOM_SOUND_RANGE for 'boom' else PHYSICS_SOUND_RANGE (d from the player's chest), splash / hiss / fizzle
  throttled by SPLASH_MIN_INTERVAL_S / HISS_MIN_INTERVAL_S / FIZZLE_MIN_INTERVAL_S; `particles` → `particles.emit`; `knock(body, vx,
  vy, vz, fromX, fromZ)` adds the velocity — a pig also gets `pigs.hit(pig, fromX, fromZ, false)` (flash and flee, NO kick: a blast
  or a log pushes every body the same) and a squeal within 16 units, at most ONE per frame (the loudest, played after
  `blockPhysics.step`: a blast through a herd took every audio voice from the boom).
  `stepPlaying` order: input & interaction → player (pull = black holes + `fluids.currentAt(player feet + 0.1)`; pigs' pullAt adds
  `currentAt(feet + 0.1)` too) → black holes → pigs → **`blockPhysics.step(dt)`** → campfires → `resolveBodies([player, pigs…,
  …blockPhysics.bodies()])` → **unstick player** (when `!isFreeAt(player)`: `findFreeY(…, floor(y)+1, 3)`, vy ≥ 0) → time → runes →
  streaming. `renderFrame`: `fallingRenderer.sync(blockPhysics.renderItems())`, `explosions.flash(out)` → `fallingRenderer.setFlash`,
  `explosions.shakeOffset(eye, out)` added to the camera position, `particles.update(dt)` (0 unless playing with physics not paused).
  Interaction: player break / place go through `blockPhysics.asPlayer(() => world.setBlock(…))`; with WATER selected (and the eye
  cell not water — §35.5) the crosshair ray uses `isHit = isTargetable(id) || isWaterSource(id)` and left-click on a source sets it to AIR; `explosions.raycast` runs after
  the pig ray (up to the nearer hit) and a lit barrel under the crosshair takes it (left-click → `explosions.snuff(target)`); R on a
  BLAST_BARREL → `blockPhysics.asPlayer(() => explosions.lightAt(q, y, r))` (chat line when explosions are off); target hints
  `Blast Barrel · R: light` / `Blast Barrel · burning! click: break it` (`explosions.isBurning`, §38.2) / `Blast Barrel (explosions
  are off)` / `lit barrel · click: put it out`.
  Saving: `edits: blockPhysics.exportEdits()` (never the live world, §33.9), `physics: blockPhysics.exportSwitches()`; autosave also
  fires when `blockPhysics.switchVersion` changed. Pause menu: `menus.showPause(seed, physicsMenuState())`; `onPhysicsToggle(name)`
  flips the switch (click + toast), `onUndoPhysics` → `blockPhysics.undo()` (chat line + toast). The CommandContext gets
  `physics` (getter). `game.physics` exposes it. `quitToTitle` / `dispose` drop it and clear the renderers.
- Diagnostics: `installErrorCapture` → `hud.showError`; `installDebugHandle`; if `params.smoke` → `runSmokeTest(game)` once playing.
- `window.resize` → `renderer.resize(innerWidth, innerHeight)`.

## 26. `src/commands.js` (PURE — the command language)

```js
export const COMMANDS                 // CommandSpec[] { name, usage, summary, args: kind[], min, scriptOnly? } — `help` renders it, tests iterate it
export const HELP_FOOTER, COMPASS     // COMPASS = { north: 0, west: 90, south: 180, east: -90 } (yaw degrees as F3 shows them)
export function parseLine(text, lineNo = 1)   // → ParsedCommand { line, name, args, raw } | ParseError { line, message } | null (blank / comment)
export function parseScript(text)             // → { commands: ParsedCommand[], errors: ParseError[] }; never throws; lines beyond
                                              //   MAX_RUNE_SCRIPT_LINES → one error "too many lines (N > 128); the rest is ignored"
export function resolveBlock(token)           // → { id } | { error }
export function parseTimeSpec(token)          // → day fraction | null ;  parseDurationSpec(token) → GAME seconds | null
export function yawToDegrees(yaw)             // radians → [-180, 180)
export function hexAreaCells(q, y0, r, radius, height, ring)  // [q,y,r][] of the disc / ring, y0 .. y0+height-1
export function executeCommand(cmd, ctx)      // → CommandResult { ok, message, wait?, stop?, job? }; never throws
```
### 26.1 Grammar (normative)
`line := WS* ( '#' .* | '/'? NAME (WS+ ARG)* )? WS*` over `text.split(/\r?\n/)`. `#` is a comment ONLY as the first non-blank character.
NAME is matched case-insensitively. `say` takes the rest of the line verbatim (trimmed; no quoting; `#` not special inside).
`NUMBER := ('~' | '@') SIGNED? | SIGNED`, `SIGNED := [+-]? ( \d+ (\.\d*)? | \.\d+ )` — no exponent, hex, Infinity or NaN.
Argument kinds: `cell` (must resolve to an integer; `~`/`@` allowed), `num` (float; `~`/`@`), `angle` (`num` or an OWN key of COMPASS — never
`constructor`), `int` (plain integer literal, no `~`/`@`), `block`, `word`, `choice:a|b`, `rest`. Parse-time checks: unknown command →
`unknown command "x" (try help)`; arg count → `<name>: expected <usage args> (got N args) — usage: <usage>` where `<usage args>` is the first
form of the usage (forms are separated by ` | ` with spaces; the `|` inside a choice list is kept); number syntax per kind; a bad choice →
`<name>: expected one of a, b, got "x" — usage: …`; choices lower-cased. `parseScript` keeps the first MAX_RUNE_SCRIPT_LINES lines and reports
`too many lines (N > 128); lines after 128 are dropped` (the store and the editor really drop them).
Every execution failure is `<name>: <message> — usage: <usage>`.
### 26.2 Resolution
`~` = the PLAYER: for cell args `worldToHex(p.x, p.z)` / `floor(p.y)`; for `tpw` the world position; for `look` the degrees F3 shows.
`@` = the EXECUTING RUNE's cell (`ctx.rune`); for `tpw` its centre and `y + 1`; in the console (`ctx.rune === null`) it is the error
`@ is only valid inside a rune script`. Offsets may be negative (`~-1`). A cell arg that is not an integer after resolution →
`expected an integer for <arg>, got "~0.5"`. Block tokens: exact `name` → `displayName` with `_` for spaces → unique prefix (name or
display name) → unique substring → integer id `0 ≤ id < BLOCK_COUNT`; `minecraft:` prefix stripped; ambiguity lists the candidates;
unknown → `unknown block "x" (type blocks to list them)`.
### 26.3 CommandContext (built by main, §23)
`{ world, player, controls {yaw, pitch}, getTime(), setTime(t) (never touches day), addTime(gameSeconds) (day += floor when passing
midnight forwards), timeFrozen, hotbar, selected, setHotbarSlot(slot, id), say(text), teleport(x, y, z), setFlying(on), runes: RuneStore,
runner: RuneRunner, rune: Rune|null, running: Running|null, seed, physics?: BlockPhysics (v0.8) }`. The runner sets `rune`/`running` around each script command; the
console executes with both `null`.
### 26.4 Commands (exact behaviour)
| command | behaviour |
|---|---|
| `help [cmd]` | all usages + summaries + HELP_FOOTER, or one command's usage |
| `blocks` | `id name (Display Name)` for AIR and every placeable block |
| `pos` | `cell q y r · world x y z (2 dp) · yaw d pitch d` |
| `seed`, `edits` | the seed; `N edited cells (≈ KB, budget MAX_TOTAL_EDITS)` |
| `tp q y r` | feet to the centre of cell (q, r) at the first free height `findFreeY(y, 2)`; refuses `y` outside `0..WORLD_HEIGHT−2`, `target is not loaded` (chunk), `target is inside a block` |
| `tp q r` | onto the surface: `findStandingY(…, WORLD_HEIGHT − 2)`; `no ground at (q, r)` |
| `tpw x y z` | world floats, `y` in `0..WORLD_HEIGHT−2`, same loaded/free rules |
| `look yaw pitch` | degrees (F3 convention), yaw may be a COMPASS word; yaw wrapped, pitch clamped to ±PITCH_LIMIT |
| `setblock q y r <block>` | refuses `bedrock cannot be placed` (BEDROCK as the block), out-of-range y, unloaded chunk, `that cell is occupied by you` (solid block intersecting the player), `bedrock cannot be replaced`; same block → ok "already"; RUNE_BLOCK allowed (the hook creates/deletes the rune) |
| `fill q1 y1 r1 q2 y2 r2 <block>` | inclusive axial box (corner order irrelevant), `(dq+1)(dy+1)(dr+1)` cells |
| `hexfill q y r radius height <block>` | `hexDiscCount(radius) · height` cells, layers `y .. y+height−1`; radius `0..AREA_MAX_RADIUS`, height `1..AREA_MAX_HEIGHT` |
| `hexring q y r radius height <block>` | the ring at exactly hex distance radius: `(radius === 0 ? 1 : 6·radius) · height` cells |
| `time set <spec>` | noon 0.5, midnight 0, day 0.25, night 0.75, `HH:MM` (0..23:0..59), bare integer 0..24 = hours (24 → 0), a number with a decimal point in [0,1] = fraction; `time is frozen by ?time=` |
| `time add <dur>` | GAME seconds (86400/day): `HH:MM`, `Nh`, `Nm`, `Ns`, a signed number with a decimal point ≤ 1 = fraction of a day, a signed integer = seconds; negatives allowed; `day` bumps only forwards |
| `fly on|off|toggle` | `setFlying` |
| `give <block> [slot]` | placeable blocks only; slot `1..9` integer literal (default: selected) |
| `say <text>` | `ctx.say(text)`; the result message is empty |
| `run q y r` | `runner.trigger(key, running ? 'run' : 'console', running ? { wave, hops + 1 } : undefined)`; failure reason is the message |
| `wait <s>` | scripts only; `WAIT_MIN_S..WAIT_MAX_S` → `{ wait }` |
| `stop` | scripts only → `{ stop }` (the script ends WITHOUT chaining) |
| `stopall` / `resume` | `runner.stopAll()` (cancel all + pause every automatic trigger) / `runner.resume()` |
| `runes` | one line per stored rune: `q y r · label · triggers|OFF · running|idle` (first 50) |
| `rune q y r on|off` | sets `enabled` (creates the entry); off also cancels its script |
| `physics status\|on\|off` | v0.8, needs `ctx.physics`: `status` → `physics.statusText()`; `off` / `on` → `setPaused` ("block physics paused: nothing falls, flows or explodes until physics on (not saved)" / "block physics running"); a lone feature name reports `<f> is on\|off` |
| `physics <falling\|water\|collapse\|explosions> on\|off` | `setSwitch` → `<f> on\|off (saved with this world)` or `(already)`; an unknown feature fails |
| `undo` | `physics.undo()`: its message (ok) or failure (`nothing to undo …`, `… too late to undo`) |
| `ignite q y r` | y in range and the cell loaded, then `physics.explosions.ignite(q, y, r)` → its `{ ok, message }` |
| `drain [radius]` | radius `0..DRAIN_MAX_RADIUS` (default DRAIN_DEFAULT_RADIUS) around the rune's cell in scripts, the player's cell (`worldToHex`, `floor(y)`) in the console → `physics.fluids.drain(q, y, r, radius)` |
All four fail with `block physics is not available here` when the context has no `physics`.
**Area commands** (fill/hexfill/hexring) validate BEFORE writing anything: `total > MAX_FILL_CELLS` → `too large: N cells (max M)`;
`rune_block` as the fill block → `use setblock for rune blocks`; `bedrock` → `bedrock cannot be placed`; any addressed `y` outside `0..WORLD_HEIGHT−1` → refused; ATOMIC across
chunks: every covered chunk column must be loaded, else `N cells are in unloaded chunks (nothing changed)`; `world.editCount + total >
MAX_TOTAL_EDITS` → `world edit budget exceeded …`. Then they return an `AreaJob` whose `step(maxCells)` writes cells in chunk-major order
(`(cq, cr)`, then q, r, y) and SKIPS cells that already hold the block (`unchanged`), RUNE_BLOCK cells (`skippedRune`), BEDROCK
(`skippedBedrock`) and — for solid blocks — cells intersecting the player (`skippedPlayer`); `summary()` →
`<name>: N cells set to <block> (… unchanged, skipped …)`. The runner advances jobs under `MAX_CELLS_PER_FRAME` per frame.

## 27. `src/runes.js` (PURE — Rune Blocks)

```js
export const RUNE_DEFAULTS   // { script:'', label:'', enabled:true, interact:true, stepOn:false, stepCooldown:1, repeat:false, repeatInterval:5, chain:false }
export const SOURCE          // { INTERACT:'interact', STEP:'step', REPEAT:'repeat', CHAIN:'chain', RUN:'run', CONSOLE:'console' }
export function runeKey(q, y, r) → `${q},${y},${r}`;  parseRuneKey(key) → [q, y, r] | null  (strict /^(-?\d+),(-?\d+),(-?\d+)$/, y in range, q/r safe integers, never −0)
export function clampScript(text)                      // ≤ MAX_RUNE_SCRIPT_CHARS chars AND ≤ MAX_RUNE_SCRIPT_LINES lines
export function normalizeRune(q, y, r, partial)        // complete Rune: unknown fields dropped, booleans coerced, stepCooldown 0..3600, repeatInterval 0.25..3600, label ≤ 32, non-finite → default
export function runeToJSON(rune)                       // non-default fields only, in order script, label, enabled, interact, stepOn, stepCooldown, repeat, repeatInterval, chain
export function isDefaultRune(rune)
export function normalizeRunesJSON(raw)                // → { runes: RunesJSON, warnings } — canonical keys (last write wins), pristine entries dropped, ≤ MAX_RUNES kept in key order
export function validateRunesJSON(raw, edits)          // normalizeRunesJSON + drop entries whose cell is not `[localIndex, RUNE_BLOCK]` in edits (orphans)
export function hasRuneEdit(edits, q, y, r)
export class RuneStore {
  constructor(max = MAX_RUNES); map; version; max      // version bumps on every change; replaceAll resets it to 0 (like World.editVersion)
  size; storedCount (non-pristine entries); get(key); has(key); ensure(q,y,r) → Rune (always; pristine entries are free); set(q,y,r,partial) → Rune|null
  (merges only the DEFINED fields of partial; null when the result would be a NEW stored rune beyond the cap); delete(key) → boolean; clear()
  replaceAll(json) → warnings; export() → RunesJSON (sorted, non-pristine, non-default fields); list() → Rune[] sorted by (q,y,r)
  sweep(world) → n   // drops entries whose cell is LOADED and not RUNE_BLOCK; never touches unloaded cells
}
export class RuneRunner {
  constructor(store, ctx); setContext(ctx); onLog = (line, isError) => {}; onTrigger = (key, source) => {}
  trigger(key, source, { wave?, hops? } = {}) → { ok, reason? }
  runConsoleLine(line) → { ok, message }   // synchronous; an area command's job is queued as a `console#N` Running
  cancel(key); cancelAll(); stopAll() (cancelAll + paused = true); resume(); reset(); seedStep(); isRunning(key); getLastRun(key); update(dt) → { executed, fired }
  hasActiveJobs() → boolean   // v0.8: some running script / console job still has an area job (block physics batches its support seeds)
}
```
### 27.1 Semantics (normative)
- A RUNE_BLOCK cell with no entry behaves as the default Rune; `ensure` creates the (pristine) entry on placement / first interact / edit.
  Only stored (non-pristine) runes count toward `MAX_RUNES`: `set` returns null when it would create one more stored rune beyond the cap
  (the block still exists; main toasts "Too many rune blocks"). The cap therefore means the same thing before and after a reload.
- `trigger` refuses, in this order, with these reasons: invalid key; `rune at (q,y,r) is not loaded`; `no rune block at (q,y,r)` (and deletes
  the entry); `rune at (q,y,r) is disabled`; `rune triggers are paused (press R on a rune or run resume)` (unless source is interact/console);
  `rune at (q,y,r) is already running`; `chain limit reached (32 hops)`; `rune at (q,y,r) already ran in this activation` (same wave);
  `too many running scripts (64)`. Interact/console sources clear `paused` and start a NEW wave; chain/run propagate the caller's wave.
  Parse errors of the script are logged at start (`[q,y,r:LINE] message`, at most 3 per run) and the well-formed lines still run; runtime
  command failures are logged with their own cap of 3 per run (the first excess of either kind becomes `… more parse|command errors suppressed`).
- `update(dt)` phases: (1) cancel scripts whose LOADED cell is no longer RUNE_BLOCK (and delete the entry); (2) `waitLeft -= dt` for every
  running script, then round-robin passes over a snapshot in start order — one command per live script per pass — until
  `MAX_COMMANDS_PER_FRAME` commands or `MAX_CELLS_PER_FRAME` job cells are spent (a script whose wait just ended resumes this frame; a
  job is advanced by `step(remainingCells)`); a failing command logs `[q,y,r:LINE] message` and the script CONTINUES; (3) pending chain
  entries age by dt and fire FIFO when due; (4) repeat: for each stored rune with `enabled && repeat` whose chunk is loaded and which is not
  running: `acc += dt`; at `acc ≥ repeatInterval` → `acc = 0`, trigger (unless paused); acc is held at 0 while the script runs and frozen
  while the chunk is unloaded; (5) step-on: cooldowns age by dt; the set S of RUNE_BLOCK keys among `supportingCells(player)` (empty unless
  `onGround`) is compared with last frame's set; for each key in S \ S_prev with `enabled && stepOn`, no cooldown left and not paused →
  trigger and set the cooldown to `stepCooldown`; `S_prev = S` every frame. `seedStep()` (spawn, teleport — also when the teleport is
  executed by a script mid-frame) seeds `S_prev` from the current position ignoring `onGround` and marks the seed PENDING; while pending,
  phase 5 leaves `S_prev` untouched and adopts `S` without firing on the first frame the player is `onGround` again — so arriving by
  teleport, including the landing after a mid-air teleport, is never a step-on.
- A script FINISHES when its cursor passes the last command → if the rune's LIVE store entry (the editor may have replaced it mid-run) has
  `chain && enabled`, enqueue `faceNeighbor(q, y, r, f)` for
  `f = 0..7` in face order with `due = CHAIN_DELAY_S`, the same wave and `hops + 1`; `stop` finishes WITHOUT chaining; CANCEL (block replaced,
  `stopall`, `rune … off`, reset) never chains. Chain targets that are not loaded rune blocks are skipped silently. Running scripts are
  detached from streaming: a chunk unloading does not cancel them (their commands simply report "not loaded").
- Nothing of the runner is ever saved: after a load no script runs, every accumulator is 0 and every cooldown has elapsed.

## 28. `src/console.js` and `src/runeEditor.js` (DOM)

```js
export function createConsole(doc, { onLine(line) → {ok,message}|void, onClose() })
/** Console = { open(prefill = ''), close(), isOpen(), log(text, isError = false), clear(), dispose() } */
export function createRuneEditor(doc, { onChange(key, partial), onRun(key), onClose(key) })
/** RuneEditor = { open(rune, lastRun = null), close(), isOpen(), getKey(), getFields(), dispose() } */
```
Console: binds `#console`, `#console-log`, `#console-input`. `open` shows the layer and, on the NEXT tick, focuses the input and sets the
prefill (so the keypress that opened it never lands in the line). Enter: empty → `onClose`; else push to history (≤ CONSOLE_HISTORY, no
consecutive duplicates), echo `> line`, call `onLine`, log `result.message` (red when `ok === false`), clear the input, stay open. Esc →
`onClose`. ↑/↓ walk the history (the unsent draft is restored below the newest entry). The scrollback keeps ≤ MAX_CONSOLE_LINES lines;
multi-line text is split. Keydown events on the input never bubble. A document-capture fallback handles Esc/Enter while the console is
open but the input lost focus (a click on the scrollback or the canvas), and refocuses the input on a printable key.
Editor: binds `#rune-editor`, `#rune-cell`, `#rune-label`, `#rune-script`, `#rune-counter`, `#rune-errors`, `#rune-enabled`, `#rune-interact`,
`#rune-stepon`, `#rune-cooldown`, `#rune-repeat`, `#rune-interval`, `#rune-chain`, `#rune-lastrun`, `#rune-run`, `#rune-done`, `#rune-revert`.
`open(rune, lastRun)` fills every field, remembers the original for Revert and shows `last run (source): finished|cancelled after N commands,
M errors` / `never run`. Typing in the script/label calls `onChange(key, fields)` after EDITOR_DEBOUNCE_MS; checkbox/number changes call it
immediately; `Run` → flush + `onRun`; `Done` → flush + `onClose`; `Revert` → original fields + flush; Esc (document capture) → flush +
`onClose`. The counter shows `n / 128 lines · m / 4096 chars`; `#rune-errors` lists `line N: message` from `parseScript` live. Typing past
MAX_RUNE_SCRIPT_LINES lines trims the textarea on input (chars are capped by `maxlength`), so what the editor shows is exactly what the store
keeps; edits are therefore never lost (main writes them to the store), and main treats Esc/Done/Run as "close" only.

## 29. `src/blackholes.js` (PURE — Black Holes, v0.5)

`BLACK_HOLE` ("Black Hole", tile 72 `black_hole`: starfield + two-armed orange→violet accretion swirl around a black horizon, alpha 255)
is placeable and breakable, `solid: false, opaque: false`, layer OPAQUE, soundGroup glass. Worldgen never emits it, so every hole is a
recorded edit.

```js
export function holeKey(q, y, r)           // "q,y,r"
export function canSwallow(id)             // false for AIR, liquids, BEDROCK, RUNE_BLOCK, BLACK_HOLE; true otherwise
export const EAT_OFFSETS                   // frozen [dq,dy,dr] list: hex distance ≤ R and centre distance ≤ R (R = BLACK_HOLE_EAT_RADIUS),
                                           //   centre excluded, sorted by distance, then dy, dq, dr
export function columnHasEdits(edits, q, r) // true when World.edits records any cell of column (q, r) (128 lookups, y innermost)
export class BlackHoles {
  holes: Map<key, {key,q,y,r,cx,cy,cz,due,offset}>; size; inert   // inert = BLACK_HOLE cells refused at the cap (do nothing)
  add(q,y,r) / remove(q,y,r) / clear()     // add refuses duplicates; past BLACK_HOLE_MAX_TRACKED (256) it records the cell as inert
                                           //   instead. remove forgets the cell (tracked or inert); when it frees a tracked slot,
                                           //   the oldest inert holes are added until the cap is full again (no reload needed)
  onBlockChange(q,y,r,prev,next)           // BLACK_HOLE appears → add; disappears → remove; a swallowable cell appears → every hole whose
                                           //   ball (|dy| ≤ R, hex distance ≤ R) contains it restarts its search (offset = 0)
  loadFromEdits(world.edits)               // clear, then add every edit whose id is BLACK_HOLE
  pullAt(x,y,z,out?) → [ax,ay,az]          // Σ over holes with 0 < d < BLACK_HOLE_PULL_RADIUS: toward the centre, magnitude STRENGTH·(1−d/R)²
  swallowing(player) → hole|null           // first hole with playerIntersectsBlock(player, q, y, r)
  nearestDistance(x,y,z,stopBelow=0)       // distance to the nearest hole centre (Infinity: none); may return early once below stopBelow
  respawnPoint(spawn, {getBlock,isLoaded,surfaceHeight,hasEdits}) → [x,y,z]   // see below
  update(dt, {getBlock,setBlock,isLoaded}) → [{q,y,r,id}]   // see below
}
```
`update` eats in rounds on one shared clock (`_clock`, set to BLACK_HOLE_EAT_INTERVAL_S when the first hole is added and by `clear`):
`clock −= dt`; when `clock ≤ 0`, `clock += INTERVAL` (reset to INTERVAL if still ≤ 0: one round per call at most) and every hole
gets `due = true` (one owed eat; owed eats never pile up). Holes are then visited round-robin from the cursor; a hole that is not
due, whose search is exhausted (offset past EAT_OFFSETS) or whose column is unloaded is skipped (staying due). Otherwise, while
fewer than BLACK_HOLE_MAX_EATS_PER_FRAME (64) cells were eaten this call, the hole scans EAT_OFFSETS from `offset` for the first
`canSwallow` cell — stopping (no cell) at one whose column is unloaded. An eat dirties the chunks of its column and its six side
neighbours (what `World.setBlock` marks); after the call's first eat, an eat that would bring the call's dirtied chunks above
max(BLACK_HOLE_MAX_EAT_CHUNKS_PER_FRAME (1), chunks dirtied so far) is held back (world.update re-meshes every dirtied chunk at
once, §9.1 step 2, so eats inside the frame's chunks are free and one frame re-meshes one chunk, or the 2–4 a border eat touches).
A held-back hole stays due, and the first one held back by either limit is where the next call starts (else the cursor advances
by one), so crowds in different chunks take turns. Otherwise `due = false` and the cell (if any) is set to AIR via `setBlock`,
reporting the old id. Because holes stay in step, a chunk full of holes is re-meshed once a round, not every frame.

`respawnPoint(spawn, world)`: columns over the hex rings 0..BLACK_HOLE_RESPAWN_RINGS (32) around spawn's column (ring n from
n × HEX_DIRS[4], n steps along each direction, like findSpawn) give candidates. A loaded column is searched UPWARD from its
natural ground, feet = `surfaceHeight(q, r) + 1` (worldgen; for spawn's own column that is findSpawn's height): the first feet
y with a solid cell at y − 1, AIR at y and y + 1 (water, a campfire or a hole there do not count) and `y + PLAYER_HEIGHT ≤
WORLD_HEIGHT`. The search climbs through solid cells and one-cell gaps, but two non-solid cells in a row that are no place to
stand end it (no candidate): the ground spot is taken by water, a hole or a fire, or was dug away, and anything higher would be
a roof, a sky platform or a canopy over that gap. So edits count — blocks stacked on the ground lift you onto them, ground a hole
ate is out — and a house built over spawn keeps you inside it, while a roof, a platform or leaves above a free spot never lift
you. An unloaded column without recorded edits (`hasEdits`) stands at its worldgen surface + 1 when the surface is ≥ SEA_LEVEL. The first candidate whose body middle (feet + PLAYER_HEIGHT/2) is at least
BLACK_HOLE_PULL_RADIUS from every tracked hole is returned (no pull there, and no eat ball reaches its floor, so a player standing
still is never swallowed); else the candidate farthest from every hole; else `spawn`.

v0.8: main's `blackHoleWorld.setBlock` writes LAZILY (`world.setBlock(q, y, r, id, true)`), and every eat reaches block physics
through onBlockChange like any removal (support seeds, gravity / water triggers).
main (§23): one `BlackHoles` for the session; `startLoading` calls `loadFromEdits(world.edits)` right after wiring
`world.onBlockChange`, whose handler forwards every change to `blackHoles.onBlockChange` first. `stepPlaying` writes
`pullAt(player.x, player.y + PLAYER_HEIGHT/2, player.z)` into `input.pullX/Y/Z` before `stepPlayer`, then (if any hole exists)
teleports a swallowed player to `respawnPoint(world.findSpawn(), view)` (view: live `getBlock`, `hasChunkAtCell`,
`getSurfaceHeight`, `columnHasEdits(world.edits, …)`); the chat line "You were swallowed by a black hole!" and the glass break
sound play at most once per BLACK_HOLE_SWALLOW_LINE_S (2 s, `fxTime`). When `inert` becomes non-zero it logs once (again only
after it has dropped to 0) "Only 256 black holes can be active at once: the rest do nothing until some are broken." Then it runs
`update`, playing at most one break sound per frame for an eaten cell within 16 units. `placeSelected` refuses a BLACK_HOLE that
would intersect the player (like solid blocks). Constants live in config.js (`BLACK_HOLE_*`); with the §12 pull rule, walking,
hopping, sprinting or flying away from a hole on the floor escapes from 1.5 units out, and standing still never does.

## 30. `src/pigs.js` (PURE) and `src/pigRenderer.js` (three) — Pigs, v0.5

A pig is `createBody(x, y, z, { radius: PIG_RADIUS 0.42, height: PIG_HEIGHT 0.9, mass: PIG_MASS 0.7 })` plus
`{ id, yaw, targetYaw, mode: 'idle'|'walk'|'flee', timer, hurt, walkPhase, oinkIn }`, moved by `stepPlayer` (so it collides with
terrain as its own cylinder, swims, hops one-cell ledges and feels black-hole pull). It fits under one-cell overhangs but not
through one-cell tunnels. At the start of each update a pig that overlaps a solid cell is lifted to `findFreeY(…, floor(y)+1, 3)`
with its own size (blocks filled into it by commands).
Pigs never die. Constants `PIG_*` live in config.js.
```js
export function seededRng(seed)                // mulberry32
export function validatePigsJSON(raw)          // → { pigs: [{x,y,z,yaw}], warnings }: finite numbers, −16 ≤ y ≤ WORLD_HEIGHT, ≤ PIG_MAX kept
export class Pigs {
  list, size, clear()
  spawn(x, y, z, yaw = 0) → Pig|null           // null at PIG_MAX or non-finite input; mode idle
  remove(pig) → boolean
  update(dt, { getBlock, isLoaded(x, z), pullAt?, hasCampfires? }) → Pig[]   // oinks due this frame; pigs with y < −16 are
                                               //   removed; pigs whose chunk is unloaded are frozen; hasCampfires() false =
                                               //   the world has no CAMPFIRE cell at all (absent: assume it may)
  hit(pig, fromX, fromZ, kick = true) → boolean  // false during the PIG_HURT_S flash; else knockback PIG_KNOCKBACK away, vy ≥ 5
                                               //   (only with `kick`; main's physics knock hook passes false, §23), hurt flash,
                                               //   mode flee for PIG_FLEE_S facing away
  raycast(ox, oy, oz, dx, dy, dz, maxDist) → { pig, distance }|null   // the body cylinder PIG_RADIUS × PIG_HEIGHT at the feet
  export() → PigJSON[] (mm-rounded) ; load(validatedList)
  spawnNatural(count, q0, r0, seed, getBlock, isLoadedCell, minDist = 4, maxDist = 18) → placed   // grass surfaces only, seeded
}
```
AI per frame (`canHop` = the pig has no `carrier` and no pig in the list has it as `carrier`, both links from the end of last
frame — §31; a pig standing on or carrying another body never hops, so pigs cannot climb a wall on each other's backs):
1. **In water** (`inWater`, mode not flee): the pig swims — mode walk. A re-aim is due when the mode was not walk, the timer ran
   out or the timer exceeds SWIM_REAIM_S 0.75 (it just fell in); at most SHORE_SEARCHES_PER_UPDATE (2) pigs re-aim per update
   (a due pig past that budget keeps its heading and re-aims on a later frame), so pigs that fell in together do not all search
   in one frame. A re-aim sets the timer to SWIM_REAIM_S and `targetYaw` toward the pig's **bank target** (below); when there is
   none the heading is KEPT (it crosses open water in a straight line instead of circling), except that a pig that touched a
   wall since its previous re-aim (`wallSinceAim`, set whenever `hitWall` after its physics step, cleared at every re-aim — a
   swimmer pressed into a high wall exit-jumps and touches it only on some frames) turns randomly within ±0.75π. No edge rule;
   steps 2–3 are skipped. "Open" for a bank (and for hopping) means not solid, not CAMPFIRE, and not water a pig would swim in:
   a flowing film whose surface is at most WADE_DEPTH (levels 1–3) counts as open, so a beach under a thin flow is still a bank.
   **Bank target**: wy = the topmost liquid cell of the pig's column, starting from floor(y) or floor(y) + 1 (neither liquid: no
   target). Columns are read at wy: *water* = liquid at wy and not solid at wy + 1; *bank* = not liquid at wy and either solid at
   wy with wy + 1 and wy + 2 open (stand at wy + 1, level with the surface) or solid at wy + 1 with wy + 2 and wy + 3 open (stand
   at wy + 2, which SWIM_EXIT_JUMP clears), open = not solid, liquid or CAMPFIRE. A breadth-first search runs from the pig's column
   over water columns up to SHORE_SEARCH (20) hex steps away (≤ 1261 columns, one window of reads per search); a step from a
   searched column to a neighbour that is water or a bank is refused when BOTH cells flanking their shared edge block it — not
   water, and solid at wy or wy + 1 for a step into water, at the bank's stand level for a step onto a bank (a one-cell gap is too
   narrow for a pig). So a bank always borders water the pig can reach. The first BFS layer that reaches a bank ends the search,
   and its bank nearest the pig (world distance) is the goal. The pig heads for the farthest node of the path back from the goal
   (the bank, then the water columns toward the pig, not its own column) whose straight line from the pig, sampled every 0.25,
   lies only in water columns (the pig's own and that node's column excepted); at worst the path's first step.
2. Timer expiry alternates idle (1–5 s) and walk (1.5–5.5 s, new heading within ±π).
3. A walking, grounded pig stops (idle 0.5–1.5 s) and turns away by 0.5–1.5π when the cell (q, r) 0.8 ahead at feet level
   fy = floor(y + 0.01) is water the pig would swim in (`physics.isSwimWater`: two cells deep, or a surface more than WADE_DEPTH
   above the floor — v0.8; shallow films are walked through), or is solid unless `canHop` and fy + 1 there is open (a one-cell ledge),
   or is open with no solid at fy − 1 or fy − 2 (a drop), or when any point 0.25, 0.5 or 0.8 ahead (FIRE_LOOK) lies within
   FIRE_MARGIN 0.15 (`hexCircleContact`) of a CAMPFIRE cell at fy or fy − 1. Order (cheap where there is no fire): the cell under
   the point is read (not again when it is the previous point's); a neighbour is read only when the point is nearer than
   FIRE_MARGIN to their shared edge (the neighbour lies beyond it, so it is farther than that otherwise), and the contact is
   computed only for a neighbour that IS a campfire. The whole fire check is skipped while `hasCampfires()` returns false.
Turning is capped at PIG_TURN_RATE; it moves forward only when within 1.2 rad of its heading, at sneak speed when walking and walk
speed when fleeing. `jump = inWater || (moving && hitWall && canHop && the cell 0.8 ahead is solid at fy and open at fy + 1)`:
a pig in water always paddles up (it floats; pressing into a bank gives SWIM_EXIT_JUMP), and on land it hops only a one-cell
ledge straight ahead. `walkPhase` advances by 4 × horizontal distance (mod 2π); when the pig moved less than LEG_SETTLE_SPEED
0.2 m/s · dt it eases toward the nearest multiple of π by `1 − exp(−LEG_SETTLE_RATE 10 · dt)` (the legs stand straight again).
`oinkIn` resets to 6–18 s.

`createPigRenderer(scene, capacity = PIG_MAX)` → `{ sync(pigs), count(), dispose(), group }`: the first `capacity` pigs are drawn
with five shared InstancedMeshes in `group` — `pig-skin` (body, head, ears, tail merged; PINK), `pig-features` (snout, nostrils,
eyes, pupils merged with vertex colours), `pig-legs` (4 instances per pig, pivoting at the hip) and their twins `pig-skin-hurt` /
`pig-legs-hurt` (emissive 0xff2a2a × 0.6), which draw the pigs with `hurt > 0` — so any number of pigs costs 3 draw calls (5 while
one flashes). Each pig's matrix is translate(x, y, z) · rotateY(yaw) of a model built facing −Z; the body is a hexagonal prism
(6-sided cylinder lying along Z, flat side down); diagonal leg pairs swing by ±`sin(walkPhase)` · 0.6 rad. `count()` = pigs drawn
by the last sync; meshes with no instances are hidden; frustum culling is off (instances move every frame).

Saves: optional `pigs: PigJSON[]` (version stays 2). serializeSave writes it whenever `data.pigs` is given — EMPTY included —
after validatePigsJSON; deserializeSave keeps any validated array (warnings for dropped entries). An absent field means the world
has never had pigs: main then places PIG_NATURAL_COUNT pigs with `spawnNatural` around the spawn cell in finishLoading.

main: `updateHit` also ray-casts pigs up to the block hit's distance (or REACH); a pig in front sets `pigTarget` and clears
`hit`. `breakTargeted` hits `pigTarget` (squeal) instead of breaking. `stepPigs` runs after `stepBlackHoles`: update (with
`blackHoles.pullAt` and `hasCampfires: () => campfires.total > 0`, §32), at most one oink per frame within 16 units (volume 1 − d/16), and pigs a black hole swallows are removed.
`renderFrame` calls `pigRenderer.sync(pigs.list)`. `placeSelected` refuses a solid block that would intersect a pig. Commands (§26):
`summon pig [q y r]` (no cell: two units ahead along the yaw, `findFreeY` with the pig's size from the feet cell; refuses at PIG_MAX, unloaded targets, or 2–3 args) and `pigs [clear]`; both fail when the
context has no `pigs`. audio: `playOink(volume)`, `playSqueal(volume)`.

## 31. `src/bodies.js` (PURE — body-to-body physics, v0.6)

Bodies are PlayerStates (physics §12) with optional `radius`, `height`, `mass` (PLAYER_MASS = 1 when absent), and the ride link
`carrier` / `carrierAt` that resolveBodies keeps (typed in types.js; read by pigs.js `canHop`, §30).
```js
export function bodyMass(b)
export function pairAngle(i, j)                // fixed, well-spread direction (radians) of the pair at list indices i < j (integer hash)
export function bodyOverlap(a, b, angle = 0) → { horizontal: rA + rB − dist, vertical: min(tops) − max(feet), nx, nz, dist }
       // n = unit(d + max(0, BODY_NEAR_DIST − dist)·(cos angle, sin angle)), d = b − a in xz: the line a→b, blended toward the
       // pair's own direction below BODY_NEAR_DIST 0.25 (exactly it when coincident; +x by default; +x if the sum is 0)
export function resolveBodies(bodies, getBlock) → contacts   // pairs overlapping on the first pass
export function detachBody(body, others)       // body.carrier = null and every o.carrier === body → null (teleports)
// BODY_NEAR_DIST 0.25, BODY_MAX_PUSH 0.25, BODY_MAX_SHOVE 0.5, CARRY_STEP 0.25, CARRY_MAX_MOVE 8 are exported from bodies.js
```
`resolveBodies`, once per frame after every body has been stepped:
1. **Carry**: for each body with `carrier` set last frame that is still in `bodies`: d = the carrier's movement since `carrierAt`;
   if |d| ≤ CARRY_MAX_MOVE (more than any body moves in a MAX_FRAME_DT frame: the carrier teleported, its rider stays), `displaceBody`
   by d in ceil(|d| / CARRY_STEP) equal steps (so a rider slides along walls, never tunnels) and remember the carrier; then
   `carrier = null`.
2. **Separate**, BODY_PASSES (3) sweeps over pairs i < j (stop early when a sweep finds nothing), with
   `bodyOverlap(a, b, pairAngle(i, j))`. `upper` = the body with the higher feet.
   (v0.8) A pair whose bodies have the same non-null `group` (PlayerState.group) is skipped: lit barrels (§37) push the player and
   pigs but never each other.
   - No horizontal overlap → nothing. No vertical overlap → nothing, except a REST: gap < 0.01, horizontal overlap > 0.05 and
     `upper.vy ≤ lower.vy` → stand (below).
   - STAND when vertical < horizontal, horizontal > 0.05 and `upper.y ≥ lower.y + 0.5·height(lower)`: `displaceBody(upper, 0,
     vertical + COLLISION_EPS, 0)`; if the full lift happened → stand: `onGround = true`, `vy = max(vy, min(lower.vy, 0))` (never
     falling faster than the carrier, but a RISING carrier does not hand over its speed: the carry already lifts the rider, and both
     launched it off a jumping carrier), `carrier = lower`, `carrierAt = [lower.x, lower.y, lower.z]`. A lift cut short by a
     ceiling is undone and falls through to a push.
   - (v0.8) A rider's `vx, vz` are relative to its carrier (step 1 carries it, step 3 hands the carrier's back). So a NEW ride —
     `lower` is not the carrier the body had at the start of this call — does the mirror of step 3: `vx −= lower.vx, vz −=
     lower.vz` (and a ride begun earlier in the same call and now replaced gives its carrier's back first). Landing on a moving
     body, or being caught by one in mid-air, keeps the rider's motion over the ground instead of adding the carrier's on top; a
     link that breaks and re-forms frame after frame no longer speeds the rider up. Both stand paths (rest and lift) do this.
   - PUSH: total = min(horizontal + COLLISION_EPS, BODY_MAX_PUSH); B moves `total · mA/(mA+mB)` along n, A moves the rest along −n,
     and if A could not (walls) B tries to take what is left — all through `displaceBody`, so nobody is pushed into terrain, and no
     body is pushed more than BODY_MAX_SHOVE in total per call (each push is cut to the body's remaining budget). So a pile of
     bodies on one point eases apart in every direction over a few frames instead of popping out along one line. Then if the normal
     relative velocity `(vB − vA)·n < 0`, a perfectly inelastic impulse `j = −vrel / (1/mA + 1/mB)` (vA −= j/mA·n, vB += j/mB·n).
3. **Release**: a body carried in step 1 whose `carrier` is no longer that carrier (it jumped or walked off) adds the carrier's
   `vx, vz` to its own, so it keeps moving with it.
main: after `stepPigs`, `resolveBodies([player, …pigs in loaded chunks], world.getBlock)`. So the player shoves pigs (and pigs nudge
the player), pigs crowd without overlapping, and either can stand on and ride the other. `game.teleport` calls
`detachBody(player, pigs.list)` (tp, tpw and the black-hole respawn: a pig on the player's head stays behind and falls).
Constants: PLAYER_MASS, BODY_PASSES, PIG_*.

## 32. `src/campfires.js` (PURE) and `src/campfireRenderer.js` (three) — Campfires, v0.7

`CAMPFIRE` ("Campfire", soundGroup wood) is placeable, breakable and targetable, `solid: false, opaque: false`, layer CUTOUT,
`meshed: false`. Tiles 73 `campfire_side` / 74 `campfire_top` (icon only; alpha-0 backgrounds — logs with a flame, and three crossed
logs on an ember bed; recipes in tiles.js are normative). Worldgen never emits it.
```js
export function campfireKey(q, y, r)
export function flicker(t, seed)            // 1 + 0.12·sin(7.3t+s) + 0.08·sin(13.1t+1.7s) + 0.05·sin(23.7t+2.9s) ∈ [0.75, 1.25]
export function scorchPlayer(player, getBlock, awayDir) → boolean   // the burn rule below; reads the BLOCK (tracked or not)
export function wouldDouseCampfire(getBlock, id, q, y, r) → boolean // the water rule below
export class Campfires {
  fires: Map<key, { key, q, y, r, x, z (cell floor centre), seed ∈ [0, 2π) hashed from the cell, slot, mark (internal) }>
                                            // TRACKED, ≤ CAMPFIRE_MAX_TRACKED
  known: Map<key, same>                     // every CAMPFIRE cell, tracked or not (only add/remove change it)
  refused                                   // read-only view { size, has(key), get(key), values() } of known − fires (empty below the cap)
  size (tracked); total (known.size); clear(); has(q, y, r) (tracked)
  add(q, y, r) → tracked?                   // duplicates ignored; past CAMPFIRE_MAX_TRACKED (1024) the fire is refused (known, untracked)
  remove(q, y, r) → known?                  // forgets the cell, tracked or not
  onBlockChange(q, y, r, prev, next)        // CAMPFIRE appears → add; disappears → remove
  loadFromEdits(world.edits)                // clear, then forEachEditedCell(edits, CAMPFIRE, add)
  retrack(x, y, z) → finished?              // advances or finishes a re-pick; see "Tracking cap"
  nearest(x, y, z, maxDist, limit = ∞)      // [{ fire, dist }] over TRACKED fires, by distance to (x, y + 0.3, z) of the fire, nearest first (ties by key)
}
export function createCampfireRenderer(scene, { makeCanvas, capacity = CAMPFIRE_MAX_MODELS })
  → { sync(near, t, dt), count(), idle(), prewarm(webglRenderer, camera) → Promise, dispose() }
```
Tracking cap: `nearest` scans every tracked fire each frame, so at most CAMPFIRE_MAX_TRACKED are tracked. While `refused` is not empty,
`retrack(x, y, z)` (a no-op otherwise) re-picks the tracked set as the CAMPFIRE_MAX_TRACKED fires nearest (x, y, z) (same distance as
`nearest`, compared squared, ties by key; the rest are refused). A re-pick starts when a fire was refused or a tracked one removed
since the last one started (or the last one ended short, below), or (x, y, z) is CAMPFIRE_RETRACK_DISTANCE (8) or more from where the
last one measured. It never sorts all fires: it keeps the nearest in a bounded max-heap on (squared distance, key). It first offers
the tracked fires (stamped `mark = −pass`; with a full tracked set the heap starts full, its root no farther than the farthest tracked
fire), then walks every known fire's position from dense typed arrays (slot order; a removal swaps the last fire into its slot),
skipping at one compare any fire farther than the heap's root and the fires offered up front, at most CAMPFIRE_RETRACK_BATCH (16384)
per call, measuring from where it started. Fires added meanwhile are visited too; a fire moved by a removal from the part not yet
walked into the walked part is offered at once; a removed fire is never kept. When the walk has seen every fire, the tracked set
becomes exactly the kept fires (only fires that change side go in or out of `fires`; `known` is untouched; kept fires get
`mark = ++marks`) and `retrack` returns true; calls that only advance a walk return false. The kept fires are always the nearest that
exist; if removals during the walk left fewer than min(cap, total), another re-pick follows. So per-frame cost stays bounded (about
a millisecond at 100 000 fires) while the result equals a full sort's. The fires around the player always have their model, light
and crackle, and fires refused at the cap come back as others go. Nothing that burns depends on tracking (`scorchPlayer`, pigs).

Renderer: each fire in `near` (at most `capacity`; extra entries are ignored) sits at its cell floor — six 6-sided stones on the cell
corners (0.72·HEX_SIZE), three 6-sided logs crossing at 60° (the middle one charred), seven embers, five 6-sided flame cones
(MeshBasicMaterial; scale/rotation driven by `flicker` and per-flame sines; inner tongues drawn over outer, renderOrder 2–6), and
SMOKE_PER_FIRE (6) camera-facing puffs cycling over 3.2 s (rise 0.85 m/s, size 0.25 → 1.0, opacity peaking at 0.32; renderOrder 10).
Fires not in `near` lose their model at once.
1. Draw calls: every part is ONE InstancedMesh shared by all fires under a Group named `campfires` — stones, logs (log/char by instance
   colour), embers, one per flame tongue, smoke (a quad billboarded in the vertex shader like a Sprite, with a per-instance `aOpacity`
   attribute) — so any number of fires costs the same 9 draw calls (0 while none is modelled: parts are hidden). Flame materials are
   transparent DoubleSide with `forceSinglePass` (one colour at one opacity blends the same in either order). Fires keep a dense slot
   each (instances [0, count)); a fire that leaves is swap-removed.
2. Shader programs: geometries and materials are created once and only disposed by `dispose()` (never when fires come and go).
   `prewarm(webglRenderer, camera)` (main calls it right after creating the renderer, while the game loads) compiles every campfire
   material against the real scene's lights and fog (`compileAsync(root, camera, scene)` when present, else `compile`), and makes each
   part draw one hidden instance (micro-scaled, 10 000 below the world) in the next rendered frame, then nothing until `sync` gives it
   fires — ANGLE/D3D11 only finishes a program's executables on its first draw. Never throws.
3. Lights: a fixed pool of CAMPFIRE_LIGHTS (4) PointLights (0xff9a40, distance CAMPFIRE_LIGHT_RANGE 14, decay 1.6), created once, at
   +0.6 above their fire with intensity `CAMPFIRE_LIGHT_INTENSITY · flicker · smoothstep(level)`. The wanted fires are the four
   nearest in `near` by `dist`, a fire that already holds a light counting CAMPFIRE_LIGHT_HYSTERESIS (0.5) nearer. A light on a wanted
   fire keeps it and rises; a light whose fire is no longer wanted (or gone) fades out where it is; a wanted fire without a light takes
   one that was free at the start of the frame, rising from 0; `level` moves by dt / CAMPFIRE_LIGHT_FADE_S (0.25 s) per frame. A light
   only changes fire at level 0, so a hand-over is a fade-out then a fade-in, never a pop.
`count()` = fires with a model; `idle()` = no model and no light holding a fire.

main: ONE `Campfires` for the session; `startLoading` calls `loadFromEdits` next to black holes and `onBlockChanged` forwards to
it. `renderFrame` advances `fxTime` by dt, calls `campfires.retrack(player eye)` and, while any fire is tracked or the renderer is not
`idle()`, syncs the renderer with `nearest(player eye, CAMPFIRE_MODEL_RANGE 64)` filtered to loaded columns and cut to
CAMPFIRE_MAX_MODELS (48). `stepCampfires` (after `stepPigs`), burn rule (`scorchPlayer`, for EVERY campfire cell, tracked or not): a
non-flying player whose feet cell (`floor(y + 0.05)`) is a campfire is bounced out — horizontal 5 m/s away from the cell centre
(backwards along the yaw at dead centre), `vy ≥ 5` — with the chat line "Ouch! That campfire is hot." at most every 2 s and a crackle;
then, if any fire is tracked, the nearest within CAMPFIRE_CRACKLE_RANGE (10) crackles with probability CAMPFIRE_CRACKLES_PER_S·dt at
volume 1 − d/10 (`audio.playCrackle`). `placeSelected` refuses a campfire that would intersect the player.
Water rule (`wouldDouseCampfire`, hand placement only): `placeSelected` refuses a campfire whose target cell is a liquid or has a
liquid directly above it, and a liquid whose target cell is directly above a campfire — water would put the fire out — with the chat
line "Water would put the campfire out." at most every 2 s. Console / rune commands write blocks as told (as they may also bury the
player), and block physics then treats what they wrote like any other block: water puts out a campfire it reaches, whoever placed
it (§35.2 — one written into or under water, beside water that spreads into its cell, or with water written on top of it, is replaced
by water with a hiss + steam), and a campfire over water or another fall-through cell breaks (§34.1). Such a campfire stays lit only
while the water switch is off (on a floor) or physics is paused (`physics off`).
Pigs: a walking pig treats a heading as unsafe when a point 0.25, 0.5 or 0.8 ahead comes within FIRE_MARGIN 0.15 of a campfire
cell at its feet level or one below (§30 AI step 3; main skips that look-ahead while `campfires.total` is 0 — every CAMPFIRE cell,
tracked or refused, is in `campfires`, so it costs nothing in a world without fire); a pig whose feet cell is a campfire (and is not already hurt) is
`hit` from the cell centre and listed in `pigs.scorched` for that update (main plays a squeal within 16 units).

## 33. `src/blockphysics.js` (PURE) — the block-physics scheduler, v0.8

One `BlockPhysics` per World. It owns the feature modules and every queue; features plug in through the registry and never
edit this file. Rationale and measurements: `docs/DESIGN-physics.md` §2; the plug-in reference is its §10.
```js
export const RINGS = ['fall', 'water', 'misc'], RING_DELAY = [1, WATER_TICKS, 1]       // ticks from schedule() to update
export const FEATURES = ['falling', 'water', 'collapse', 'explosions']
export const WRITE_EXTERNAL = 0, WRITE_PHYSICS = 1, WRITE_QUIET = 2                      // the `mode` triggers receive
export const CAUSE_WORLD = { kind: 'world' }, CAUSE_PHYSICS = { kind: 'physics' }, CAUSE_AREA = { kind: 'area' }
export class SeedQueue        // support seeds: priority lane + normal lane, cell-level dedupe; size, push(seed), shift(), peek(), clear()
export class SaveOverlay      // copy-on-write save view: peek(q,y,r), set(q,y,r,id), toJSON() → EditsJSON (§33.9)
export class BlockPhysics {
  constructor(world, hooks = {}, { now }?)   // hooks: PhysicsHooks (§33.7), missing ones are no-ops; now: ms clock (default world._now)
  world; hooks; ctx (RuleContext, §33.3); fallers; fluids; support; trees; explosions   // the feature modules (§34–§37)
  switches { falling, water, collapse, explosions }; switchVersion; paused; tickCount; time; stats; seeds (SeedQueue); lastEvent
  registerRule(name, { ring | rings, feature?, ids?, update(ctx, q, y, r, id) }); unregisterRule(name); ruleNames(ring)
  addTrigger(name, feature, fn(q, y, r, prev, next, mode)); removeTrigger(name)
  addReseeder(name, feature, ids, fn(ctx, q, y, r, id)); removeReseeder(name)
  schedule(ring, q, y, r, delay?) → boolean; queued(ring?) → n; isQueued(ring, q, y, r); get parkedCount
  isEnabled(feature); setSwitch(name, on) → changed; setPaused(on); exportSwitches(); importSwitches(raw)
  onBlockChange(q, y, r, prev, next); onChunkGenerated(cq, cr)          // main forwards World's hooks
  seedSupport(cells, { priority?, cause?, removed? }) → queued; seedRemoval(q, y, r, prev, opts?); collectAreaSeed(q, y, r, prev);
  flushAreaSeeds(); get areaSeedCount; seedRemovals(cells: [q, y, r, prev][], opts?) → queued   // ONE seed for a gravity column
  asPlayer(fn); withCause(cause, fn); get cause
  beginEvent(kind, cause?) → PhysicsEvent; endEvent(); get openEventId; enterEvent(id) → token; exitEvent(token); withEvent(id|ev, fn);
  get canUndo; undo() → { ok, message, restored }
  step(dt); tick(); renderItems() → { items: RenderItem[], count }; bodies(out = []) → out; exportEdits() → EditsJSON;
  status(); statusText(); clear()
}
```
### 33.1 Tick and rings
1. `step(dt)`: `time += dt` (always); nothing else while `paused`; `acc += dt`; if `acc ≥ PHYSICS_TICK_S`: `acc = min(acc −
   PHYSICS_TICK_S, PHYSICS_TICK_S)` and run ONE `tick()`; then `fallers.step(dt)`, `trees.step(dt)`, `explosions.step(dt)`.
2. A ring is a FIFO of `packCell` keys with their due tick, deduplicated per ring (`schedule` of a queued cell returns false and keeps
   the earlier slot). Every entry of a ring has the same delay, so a ring is sorted by due tick: `tick()` pops from the head while
   `due ≤ tickCount`. `schedule` refuses y outside 0..WORLD_HEIGHT−1; `delay` (integer ≥ 1) overrides the ring's delay.
3. `tick()`: `tickCount++`; flush the area seeds when `!hooks.areaJobsActive()` (§33.6); drain `fall`, then `misc`; when collapse is
   on and (`seeds.size > 0 || support.busy`) → `support.step(ctx, seeds, MAX_SUPPORT_VISITS_PER_TICK)` — or with `maxVisits =
   SUPPORT_STARVED_VISITS` when the rings already spent the whole budget (one huge update) — then drain `water`; then, while budget
   is left, drain `fall` and `misc` again. FAIR SHARES (v0.8 review, CORE-2 / §38.4): while a later consumer has work due (a due misc
   entry, a pending collapse, a due water entry), `fall` stops at FALL_SHARE = ½ of the budget, `misc` at MISC_SHARE = ⅝ (cumulative,
   counts and time), and the support step's `ctx.deadline` is `start + SUPPORT_SHARE·budget` (⅞) while water is due; the water ring
   gets the rest, and the second pass hands what is left back to fall and misc. A ring with due updates runs at least
   MIN_RING_UPDATES = 8 of them (or one update that wrote ≥ 32 cells) per tick even when an earlier one overran: a saturated ring
   slows the others down, it never stops them (a 631-source rain used to hold water and misc for ~450 ticks).
4. Budget: one per tick across all rings: stop when `MAX_CELL_UPDATES_PER_TICK` updates ran, or — checked before every 32nd update
   AND after any update that wrote ≥ 32 cells since the last check (a gravity column, §34.1) — when `now() − start ≥
   PHYSICS_TICK_BUDGET_MS`. Leftovers stay at the head (FIFO: nothing starves; there is NO per-chunk cap). `ctx.deadline = start +
   PHYSICS_TICK_BUDGET_MS` for the support search, whose every part stops on it (§36.1.4).
5. Running a popped cell: `id = world.peekBlock`; UNLOADED → park it on its own chunk (§33.4). Otherwise every rule of that ring, in
   registration order, whose feature switch is on and whose `ids` include `id` runs `update(ctx, q, y, r, id)`; after a rule that
   wrote, later rules see the re-read id. A rule that throws is skipped (one `console.warn` per rule); the tick goes on.
### 33.2 Rules
`registerRule(name, spec)` replaces a rule of the same name. `ring` (or `rings`) names one or more rings; `feature` gates it (null =
always); `ids` limits it (omitted = every id, including AIR). The gravity rule (§34) is `fall`/'falling'/[SAND, RED_SAND, GRAVEL,
CAMPFIRE]. Water (§35) registers ONE rule on `['water', 'fall']`; ignition (§37) on `misc` with [BLAST_BARREL].
### 33.3 RuleContext (`physics.ctx`, one object)
`physics, world, hooks, tick, time, deadline, now()`, `peek(q, y, r)` (World.peekBlock; remembers the last UNLOADED cell),
`write(q, y, r, id)` / `writeQuiet(q, y, r, id)` → `'ok' | 'failed' | 'capped'`, `schedule(ring, q, y, r, delay?)`, `park(q?, r?)`,
`random()` (mulberry32 seeded from the world seed), `say(text)`, `sound(name, x, y, z, volume = 1)`, `particles(kind, x, y, z,
count = 8, opts)`, and the getters `fallers, fluids, support, trees, explosions`.
**Writes** (`_write`): y outside 0..127 or an UNLOADED cell → `'failed'`; current id === id → `'ok'` (nothing written);
`world.editCount ≥ MAX_TOTAL_EDITS && !world.hasEdit(cell)` (it would add a NEW entry) → `'capped'`, with ONE chat line through
`hooks.say` (re-armed once editCount < 95 % of the cap); else `world.setBlock(q, y, r, id, true)` (lazy) with the write mode set for
the triggers (`write` → WRITE_PHYSICS, `writeQuiet` → WRITE_QUIET) and, when an event is open (§33.8), recorded into it.
### 33.4 Parking and re-seeding
1. `ctx.park()` parks the CURRENT update on the chunk of the last UNLOADED cell `ctx.peek` returned (or of column (q, r) when given):
   it leaves the ring and waits in `parked[chunkKey]` (a Set of `ringIndex·2^50 + key`), at most MAX_PARKED_UPDATES in total
   (beyond: dropped and counted in `parkedDropped` — re-seeding covers them).
2. `onChunkGenerated(cq, cr)` re-queues every update parked on that chunk (due next tick), then hands every EDITED cell of the chunk
   whose id a reseeder lists to `fn(ctx, q, y, r, id)` (reseeders of switched-off features are skipped).
3. Built-in reseeders: 'gravity' (falling): SAND/RED_SAND/GRAVEL/CAMPFIRE over a fall-through cell → `fall`, and every edited
   fall-through cell (AIR, CAMPFIRE, any water) with a gravity block or a campfire above it → that cell into `fall` (the rings are not
   saved: natural sand dug out from under just before a save — always so under `physics off` — falls after the reload); 'water' (water):
   WATER → its open neighbours (AIR, CAMPFIRE, FLOW, FALL) per §33.5.2, FLOW/FALL → `scheduleWaterAround` (fluids.js replaces it
   by name with a superset, §35.3); 'ignite' (explosions):
   BLAST_BARREL with a CAMPFIRE among its 8 neighbours → `misc`.
### 33.5 Triggers (`onBlockChange`, every change from any source)
1. Registered triggers run in order, each only while its feature is on, with `(q, y, r, prev, next, mode)`.
2. Built-ins: **'gravity'** (falling): `!isFallThrough(prev) && isFallThrough(next)` and the cell above is a gravity block or a
   campfire → `fall` (above); `next` is a gravity block or a campfire and the cell below is fall-through → `fall` (this cell).
   **'water'** (water): `isWater(prev) || isWater(next)`, or fall-through-ness or solidity changed and a neighbour is water (read with
   `peekNeighbours`, §36: straight from the written cell's chunk, which onBlockChange looks up ONCE per write for the built-in
   triggers and the area collector) →
   `scheduleWaterAround(q, y, r)`: the cell and its 8 neighbours, each only if it is water, AIR or CAMPFIRE, into `fall` when it is
   FALL or a non-source cell with water above, else into `water`. **'ignite'** (explosions): `next === CAMPFIRE` → every BLAST_BARREL
   neighbour into `misc`; `next === BLAST_BARREL` with a CAMPFIRE neighbour → itself into `misc`.
3. Then the support seed (§33.6). Neighbours are the 6 HEX_DIRS sides, then above, then below.
### 33.6 Support seeds (the search itself is support.js, §36)
1. A change with `isLoadBearing(prev) && !isLoadBearing(next)` while collapse is on: mode QUIET → nothing (physics' own crumble /
   topple / blast removals queue ONE boundary search themselves); mode EXTERNAL with no cause set and `hooks.areaJobsActive()` →
   `collectAreaSeed`; otherwise `seedRemoval(q, y, r, prev, { cause, priority: cause.kind === 'player' })` with cause =
   the asPlayer / withCause cause, else CAUSE_WORLD (external) / CAUSE_PHYSICS.
2. `seedRemoval` seeds the load-bearing neighbours (none → nothing) with `removed: [[q, y, r, prev, wasAnchor]]`, where wasAnchor =
   `y === 0 || prev === BEDROCK || (isSolid(prev) && y ≤ terrainHeightAt(q, r) && originAt(q, y, r) === prev)` — the removed cell
   was untouched terrain.
3. `seedSupport(cells, opts)` queues a SupportSeed `{ cells (copy), removed (default []), cause (default: current cause or
   CAUSE_PHYSICS), priority, event: openEventId, tick }`; dropped while collapse is off. The SeedQueue omits cells already pending in
   an earlier seed, drops a seed left with no cells and no removals, holds ≤ MAX_PENDING_SUPPORT_SEEDS (`dropped` counts the rest);
   `shift()` returns the oldest priority seed, else the oldest normal one, and its cells stop being pending.
4. Area batching: `collectAreaSeed` appends only the removal `[q, y, r, prev, wasAnchor]` — no neighbour reads (the search looks at
   the 8 neighbours of every removal itself, §36.1.1, and by then most are cells the same job removed); `flushAreaSeeds()` (automatic
   at the start of the first tick with no active area job, O(1)) queues them as ONE seed with cause CAUSE_AREA, `cells: []` and every
   removal in `removed`. A `fill … air` of MAX_FILL_CELLS used to cost ~8× its pre-v0.8 per-cell time and a 0.2–0.4 s freeze after it.
5. Switching collapse off clears every pending seed and the area batch.
6. `seedRemovals(cells, opts)` (collapse on, cells non-empty): ONE seed `{ cells: [], removed: cells with their wasAnchor }` — the
   gravity rule's column (§34.1).
### 33.7 Hooks (PhysicsHooks)
`say(text)`, `areaJobsActive()`, `bodies()` (player + pigs in loaded chunks; never buried by a landing), `player()`, `sound(name, x, y,
z, volume)` with names 'thud' | 'splash' | 'boom' | 'hiss' | 'creak' | 'fizzle' | 'crackle' | 'break:<soundGroup>', `particles(kind,
x, y, z, count, opts)` (§34.5), `knock(body, vx, vy, vz, fromX, fromZ)` (default: add the velocity, onGround = false).
### 33.8 Switches, pause, causes, events and undo
1. `setSwitch` changes a FEATURES switch (`switchVersion++`) and calls the owning module's `onSwitch(on)` (falling → fallers, water
   → fluids, collapse → support and trees, explosions → explosions). A switched-off feature drops its triggers, reseeders and rules
   (queued updates are skipped when popped) — switching it on again never acts on what happened meanwhile. `importSwitches(raw)`:
   each switch = `raw[name]` when boolean, else true; it does not bump switchVersion. New worlds: all on; saves without `physics`:
   collapse off (main, §23).
2. `paused` (console `physics off`): no ticks, entities frozen; triggers still queue; not saved.
3. `beginEvent(kind, cause)` makes a new PhysicsEvent `{ id, kind, cause, time, cells: Map<packCell, prev·256 + wrote>, truncated }`
   the ONLY undoable one (`lastEvent`) and records every write into it until `endEvent()` (nestable). A cell keeps the id from before
   the event's first write and the id of its last write; beyond UNDO_MAX_CELLS cells `truncated = true`. `openEventId` is stamped on
   fallers / tumblers / seeds created meanwhile; `enterEvent(id)` / `withEvent(id, fn)` record later writes (landings) into event `id`
   only while it is still `lastEvent`.
4. `undo()`: no event → `{ ok: false, 'nothing to undo (only the last explosion, collapse or falling tree can be undone)' }`; older
   than UNDO_WINDOW_S of `time` → refused (`… too late to undo`) and forgotten. Else `lastEvent = null`; `cancelEvent(id)` on fallers
   and trees (entities in flight removed) and support (a crumble still coming down into the event stops, §36.3.2); then every recorded cell whose current id is still the id the event wrote — or is
   water-family where the event wrote AIR (§38.3) — is written back (quiet, lazy, ignoring the edit cap), the cells whose old id is
   BLAST_BARREL LAST; then `explosions.cancelEvent(id, writeBarrel)` (§37.4.3: the event's burning barrels stop, its lit barrels are
   given back in the cells they were lit in, through the same quiet uncapped write). So no barrel takes a cell the restore needs (a
   campfire it fell into, sand that dropped into its lit cell).
   **Undo never leaves an unlit BLAST_BARREL next to a CAMPFIRE** (8-neighbourhood, as the world stands after the other restores): it
   would only catch again — through the 'ignite' trigger at once, or through the reseeder on the next load — and blow the restored
   scene up a second time. Such a barrel cell is not restored, such a used-up barrel is not given back (both counted as "not given
   back"), and a barrel of the event still burning there keeps burning as the campfire's (§37.4.3).
   Message: `undid the <kind>: restored N block(s)[, removed M still in flight][ (K changed since, left alone)][ (U in unloaded
   chunks)][ (F barrel(s) next to a campfire not given back)][ (L barrel(s) found no room)]` — N counts the event's cells (not the
   barrels given back), M includes the event's lit barrels put out.
### 33.9 Saving (`exportEdits`, never touches the live world)
`overlay = new SaveOverlay(world)`; `fallers.settleInto(overlay)`, `support.settleInto(overlay)` (what a collapse has not brought
down yet is saved fallen, §36.6.4), `trees.settleInto(overlay)`, `explosions.settleInto(overlay)`;
return `overlay.toJSON()`: world.edits overridden by the overlay's cells, where an edit of FLOW_1..6 / FALL is DROPPED when its origin
is AIR or WATER (the cell reloads as generated: a refilled hole in a lake is lake again) and saved as AIR otherwise (sources and
the AIR next to natural water re-flow through the 'water' reseeder on load, §35.3). `overlay.peek` = overlay cell, else
`world.peekBlock`; `overlay.set` refuses y outside 0..127.
### 33.10 Rendering and status
`renderItems()` fills a pooled list `{ items, count }` (`RenderItem = { id, x, y, z, rx, ry, rz, scale }`, centre + Euler 'YXZ' +
uniform scale) from `fallers.renderItems(push)`, `trees.renderItems(push)`, `explosions.renderItems(push)` with
`push(id, x, y, z, rx = 0, ry = 0, rz = 0, scale = 1)`. `bodies(out)` appends `explosions.bodies(out)`. `status()` → `{ paused,
switches, queued: { fall, water, misc }, parked, seeds, fallers, tumblers, trees, litBarrels, edits, tick, lastTickMs,
lastTickUpdates, canUndo }`; `statusText()` is its one-line form (console `physics status`).

## 34. `src/fallingblocks.js` (PURE), `src/fallingRenderer.js` and `src/particles.js` (three) — falling blocks, v0.8

```js
export const GRAVITY_RULE_IDS        // [SAND, RED_SAND, GRAVEL, CAMPFIRE]
export class FallingBlocks {         // physics.fallers
  constructor(physics)               // registers the 'gravity' rule (fall ring, feature falling)
  count; get tumblerCount; tumblers: Tumbler[]
  spawn(id, q, y, r, { vy = 0, event = openEventId }?) → animates?   // a column faller with its bottom at y; the cell is NOT touched
  crumble(cells: [q,y,r][], { event, settle }?) → n                   // writeQuiet AIR (lowest first), then drop them (§34.2)
  settleNow(id, q, y, r, { event }?) → placed                         // instant column drop with the landing rules
  spawnTumbler(id, x, y, z, vx = 0, vy = 0, vz = 0, { spin?: [wx,wy,wz], persistent?, event?, data? }?) → Tumbler|null
  removeTumbler(t) → boolean; cancelEvent(id) → n; reset(); faller(i) → { id, q, y, r, vy, event }|null
  step(dt); renderItems(push); settleInto(overlay)
}
/** Tumbler = { id, body (createBody FALLER_RADIUS × FALLER_HEIGHT), rx, ry, rz, wx, wy, wz, scale, persistent, event, data } */
```
### 34.1 Gravity rule (`fall` ring)
For a cell holding a gravity block or a campfire: below = `ctx.peek(q, y−1, r)`; UNLOADED → park; not fall-through → nothing. A
CAMPFIRE breaks: `ctx.write(AIR)`, 10 'smoke' particles at y + 0.3, sound 'break:wood'. A gravity block drops its whole column:
from y upward while the cells are gravity blocks (at most MAX_COLUMN_FALL), each is written AIR with `ctx.writeQuiet` (stop at the
first refused write) and becomes a faller at its own cell — so the column falls together, at one speed — and the column queues ONE
support seed with all its removals (`physics.seedRemovals`; cause = the current cause, priority for a player cause) instead of one
per cell (a cut 217-column sand tower used to queue thousands). When fewer than n slots are free, the LOWEST (n − free) settle
instantly (`settleNow`) and the rest animate. The scheduler reads its clock after such an update (≥ 32 writes, §33.1.4), so a tick
overruns its budget by at most about one column. Falling into a campfire or any water passes through it (v0.8 water,
§35.6: sand sinks through sources to the bottom; the landing cell's water is crushed).
### 34.2 Column fallers
1. Kept in typed arrays (id, q, r, y, vy, event) sorted by y (insertion sort per frame — or one index sort when more than 32 were
   spawned since the last sort: columns spawned bottom-up one after another made the insertion sort quadratic) and processed LOWEST
   FIRST, so a stack landing in one frame piles up exactly. Frozen while `!world.hasChunkAtCell(q, r)`.
2. Per frame: `vy = max(vy + GRAVITY·dt, TERMINAL_VELOCITY)`, `y1 = y0 + vy·dt`. If the cell containing the bottom
   (`c0 = floor(y0)`, when y0 is not an integer) is not fall-through, land at `c0 + 1`. Otherwise sweep `b = c0 − 1 … floor(y1)`
   (b ≥ 0) and land at `b + 1` on the first cell that is not fall-through. No landing and `y1 < 0` → removed. Else `y = y1`.
3. **Landing** in cell C (`_placeLanded`): if C is not fall-through, move up (≤ 4 cells) to the first fall-through cell, else break.
   For a solid id, every body in `hooks.bodies()` that `playerIntersectsBlock` C is lifted to `findFreeY(world + C, x, z, floor(y)+1,
   3, its radius, its height)`; if any has no room the block BREAKS (dust, nothing placed). Then `ctx.write(C, id)` inside
   `enterEvent(faller.event)`; `'capped'` / `'failed'` → break. Lifted bodies: `y = freeY`, `vy = max(vy, 0)`. Placed: dust (the first
   LANDING_DUST_PER_FRAME landings of a frame) and one 'thud' per frame at the landing nearest `hooks.player()`.
4. `crumble(cells, { settle })`: AIR / UNLOADED cells skipped; sorted by (y, q, r); removed with `ctx.writeQuiet(AIR)` inside
   `enterEvent(event)`; the lowest `max(0, n − (MAX_FALLING − count), settle)` settle instantly, the rest animate (one that finds no
   free slot settles too). `spawn` beyond MAX_FALLING settles instantly. `settleNow` first settles every column faller still in
   flight BELOW it in its column (lowest first: a block never lands under one that was beneath it — a column cut again while it
   falls, a crumble slice at the cap), then drops from `floor(y)` (clamped) while the cell below is fall-through; below 0 → gone.
5. Saving (`settleInto(overlay)`): fallers lowest first; from `floor(y)` move up past non-fall-through overlay cells, then down while
   the cell below is fall-through, and `overlay.set` the id there (columns in unloaded chunks are skipped). Debris is not saved;
   persistent tumblers are their owner's (explosions saves lit barrels).
### 34.3 Tumblers
`MAX_TUMBLING` at once (`spawnTumbler` → null beyond; callers turn extra debris into dust). Per frame (frozen in unloaded chunks):
`vy = max(vy + GRAVITY·dt, TERMINAL_VELOCITY)`; velocity × `TUMBLE_AIR_DRAG^(60·dt)`; on the ground horizontal velocity and spin ×
`TUMBLE_GROUND_FRICTION^(60·dt)`; move with `displaceBody` in `n = ceil(max|Δ| / TUMBLE_SUBSTEP)` equal substeps; rotation += spin·dt.
A non-persistent tumbler that hits a floor while moving down vanishes in 10 dust particles; any tumbler below y = −16 is removed.
### 34.4 `createFallingRenderer(scene, atlasTexture)` → `{ sync(items, count = items.length), setFlash(x, y, z, intensity), count(), meshCount(), prewarm(webglRenderer, camera) → Promise, dispose() }`
One InstancedMesh per (block id, render layer) from `mesher.buildCellMesh(id)` (ids with no geometry — CAMPFIRE — draw nothing),
three Lambert materials like the chunks' (opaque; cutout alphaTest 0.5 DoubleSide; translucent transparent, depthWrite false,
DoubleSide, renderOrder 1) on the shared atlas texture (never disposed here), `frustumCulled = false`, DynamicDrawUsage. Capacity
starts at 16 and doubles (a new InstancedMesh on the same geometry, inside the sync that needs it: the matrices that sync already
wrote are copied into the new mesh, so no block of that id is drawn at the world origin for a frame). `sync` composes position
(x, y, z), `Euler(rx, ry, rz, 'YXZ')` and scale for items[0 .. count); meshes with no instance are hidden. One PointLight (0xffd49a,
distance 28, decay 1.4, intensity 0) is created at construction for the explosion flash (a constant light count).
`prewarm(webglRenderer, camera)` (main calls it right after creating the renderer, like the campfires' §32.2) builds the meshes of
`PREWARM_IDS` = [SAND, GLASS, ICE] — one per layer, so the three materials' InstancedMesh programs — compiles them against the real
scene (`compileAsync(mesh, camera, scene)` when present, else `compile`), and makes each draw one hidden instance (micro-scaled,
10 000 below the world) until it has been rendered once (`onAfterRender`) or its id has instances of its own; `sync` keeps that
instance (main's `sync([], 0)` on load included). So the first falling block of a session (and the first of each layer) compiles
nothing mid-frame. Never throws.
### 34.5 `createParticles(scene, { capacity = PARTICLE_CAPACITY, random })` → `{ emit, update(dt), count(), clear(), prewarm(webglRenderer, camera) → Promise, dispose(), points }`
ONE `THREE.Points` (ShaderMaterial: world-unit point sizes, soft round sprites, terrain fog, transparent, depthWrite false,
frustumCulled false); `emit(kind, x, y, z, count = 8, { id?, color?, spread = 0.35, speed = 1, vx, vy, vz })` with kinds
`PARTICLE_KINDS = ['dust', 'leaves', 'smoke', 'sparks', 'steam']` overwrites the oldest particle when full. Dust / leaves with `id`
take `blockParticleColor(id)`: the sRGB mean of the block's top tile, × the plains BIOME_TINT when the mesher tints that face. `update(0)`
freezes; a particle fades over its life and is dead (size 0, alpha 0) after it; the Points is hidden while none live — except after
`prewarm(webglRenderer, camera)` (main, with the falling renderer's): it compiles the Points (`compileAsync(points, camera, scene)`,
else `compile`) and draws one dead point (palpha 0 → `gl_PointSize` 0) until it has been rendered once (`update` and `clear` keep
that draw), so the first particle of a session compiles nothing mid-frame. Never throws.

## 35. `src/fluids.js` (PURE) — flowing water, v0.8

Rationale and measurements: `docs/DESIGN-physics.md` §4. Water is a FAMILY (§5): WATER is a **source** (it never changes by itself);
WATER_FLOW_1..6 (level k) and WATER_FALL (water with water above it) are derived from their neighbourhood, never placed by hand and
never saved (§33.9). Wired elsewhere: the scheduler's 'water' trigger (§33.5), main's WATER-selected ray, source removal and current
pulls (§23), `drain` (§26), the surfaces in the mesher (§10.2) and physics (§12.1). A lit barrel touching water is put out by
explosions.js (§37), which reads `isWater` itself — fluids exports no hook for it.
```js
export const WATER_RULE_IDS          // [AIR, CAMPFIRE, WATER, WATER_FLOW_1..6, WATER_FALL]
export function isFlowingWater(id)   // WATER_FLOW_1..6
export function isWaterFloor(id)     // water standing on it spreads sideways: id === WATER || isSolid(id)   (UNLOADED → false)
export function flowId(level)        // WATER_FLOW_level for 1..6 (floored, ≥ 7 → FLOW_6); < 1 → AIR
export function fallLevel(ctx, q, y, r) // E of the FALL at (q, y, r): walk up its FALL column; WATER on top → 7, FLOW_k → k, else 0
export class Fluids {                // physics.fluids
  constructor(physics)               // registers rule 'water' { rings: ['water', 'fall'], feature: 'water', ids: WATER_RULE_IDS },
                                     //   trigger 'water-floor' (feature water) and replaces the reseeder 'water' (§35.3)
  maxDrainRadius;                    // DRAIN_MAX_RADIUS
  stats;                             // { updates, writes } of the rule
  drain(q, y, r, radius) → { ok, message }
  currentAt(x, y, z, out) → out [ax, ay, az]
  reset(); onSwitch(on)              // no state is held between updates: the world is the state
}
```
### 35.1 Definitions
`E(n)`: 7 for WATER, k for FLOW_k, and for FALL `fallLevel` — the level of the water pouring in at the top of its column (the first
non-FALL cell above: WATER → 7, FLOW_k → k, anything else → 0). A water cell n **spreads** (feeds its six side neighbours) iff the cell
below n is a floor (`isWaterFloor`): solid or a WATER source — never over FALL, FLOW, AIR, a campfire or UNLOADED. *This one predicate
bounds waterfalls: falling water only spreads where it lands. And falling keeps a stream's level, it never refreshes it: with E(FALL) = 7
every 1-high step of a hillside restarted a full reach-6 disc, and one source on seed 7's highest hilltop wet 9,999 cells down to the
sea (24,409 on a synthetic 40-step staircase); now every FLOW_k is within 7 − k cells of a source and the same source wets 148.*
### 35.2 The rule (`update(ctx, q, y, r, id)` on the `water` and `fall` rings)
Every input is read before anything is written. A side neighbour that is UNLOADED: when `id` is water, `ctx.schedule('water', that
cell)` (it parks on its own chunk), then `ctx.park(its q, r)` and return — both re-run when that chunk is generated. The target:
1. `id === WATER` → WATER.
2. Otherwise, with `sources` = the WATER side neighbours and `fed = max(E(n) − 1)` over the side neighbours n that spread:
   a. `id` is FLOW_k or FALL, and either `sources ≥ WATER_SOURCE_NEIGHBOURS` (3) with the cell below a floor (infinite source), or
      the cell was generated as WATER (`world.originAt(q, y, r) === WATER`: natural sea / lake water coming back — the save drops such
      an edit anyway, §33.9, so the live world and a reload agree) → **WATER**;
   b. else the cell above is water → FALL;
   c. else `fed ≥ 1` → FLOW_fed;
   d. else AIR (a CAMPFIRE stays a CAMPFIRE).
3. `target !== id` → `ctx.write(target)`; when 'ok': a replaced CAMPFIRE → `ctx.sound('hiss', centre)` + 12 'steam' particles; an empty
   cell that became FALL over a floor, or FLOW_6 → `ctx.sound('splash', centre, 0.8 | 0.4)` (main throttles). Then return (also on
   'capped': physics holds water back). The trigger queues the cell below new water on the `fall` ring, so **a waterfall advances
   exactly one cell per tick**.
4. Unchanged, the target is WATER or FLOW_k, `y > 0` and the cell below is AIR, CAMPFIRE or FLOW → `ctx.write(below, FALL)` (a campfire
   there: hiss + steam).
Consequences (`tests/unit/fluids.test.js`): one source on flat ground → exactly 126 FLOW cells, level `7 − hex distance`; one source in
mid-air → a FALL column landing at full strength (E 7) and those 126 FLOW cells around where it lands; one source on a 10-high, radius-3
plateau → 367 water cells (240 falling: the FLOW_3 over the edge lands as 3 and spreads FLOW_2, FLOW_1), and none — with every edit pruned
— once the source is removed; down a staircase (or seed 7's hillside) every FLOW cell is `7 − its hex distance` from the source, within
reach 6; two adjacent sources stay two sources (their two shared neighbours see only 2); three around a hole make 7 and stop; a hole
next to a straight sea edge fills (FLOW_6, over FALL when deeper); a drained patch of open sea refills to the generated sea and leaves
no edits — over a flat or an uneven seabed (before natural water healed by 2a, `drain 6` over seed 42's sloping seabed left 163 cells
AIR and 369 edits: the surface ring stood on FALL, the bottom ring touched sand instead of three sources).
### 35.3 Trigger and reseeder
1. **'water-floor'** (feature water): `isWaterFloor(prev) !== isWaterFloor(next)` and the cell above is water → wake each side neighbour of
   that water cell which is AIR, CAMPFIRE, FLOW, FALL or UNLOADED. Also: `prev !== next`, either is water and the cell below is FALL → walk
   down that FALL column to where it lands; when the cell under its lowest FALL is a floor, wake that landing's side neighbours the same
   way (its `fallLevel` changed). (*The scheduler's 'water' trigger covers the changed cell and its 8 neighbours; the rule also reads the
   cells below its side neighbours and the column above a falling one.*) **Wake** = `schedule('fall', …)` for FALL or a non-source cell
   with water above, else `schedule('water', …)`.
2. **Reseeder 'water'** (replaces the built-in of §33.4 by name; feature water) — EDITED cells of a generated chunk: AIR → wake it when the
   cell above or a side neighbour is water, or a side neighbour is UNLOADED (*a hole dug beside the sea: flow is never saved*); WATER → wake
   its 8 neighbours that are AIR / CAMPFIRE / FLOW / FALL / UNLOADED; FLOW / FALL → wake itself and those neighbours. A woken UNLOADED cell
   parks on its own chunk and runs when it loads.
### 35.4 Surfaces: rendering, wading and swimming
`waterSurfaceHeight(id, above)` (blocks.js, §5) is the one surface rule. The mesher draws it (§10.2: lowered tops always drawn, nothing
between two water cells but the strip of the higher surface above the lower one). physics.js (§12.1): a body is `inWater` (swims) only
when its feet cell is water deep enough to swim in (`isSwimWater`: two cells deep, or a surface more than `WADE_DEPTH` (0.4) above
the floor) or its chest point is under a surface; shallower water is
**wading** — walking and jumping as on land at `WADE_SPEED_FACTOR` (0.85); `headInWater` = the eye point under a surface
(`isUnderSurface(getBlock, q, py, r)`). So a level-1..3 film is wading, level ≥ 4, sources and falling water are swimming. Pigs avoid only
water they would swim in (`isSwimWater(getBlock, q, y, r)`: the water at y, or one step down at y − 1, is two cells deep or its surface is
more than WADE_DEPTH above its floor; §30).
### 35.5 Taking water away, drain, currents
- WATER selected: the crosshair ray also stops on WATER sources — unless the eye cell is water (the ray would stop at once) — and
  left-click sets the source to AIR (`blockPhysics.asPlayer`, main §23); the flow it fed drains by itself; a natural sea / lake cell
  refills as a source as soon as water flows back into it (rule 2a), a placed source does not.
- `drain(q, y, r, radius)`: `radius` an integer 0..DRAIN_MAX_RADIUS (else `{ ok: false }`). Every water cell with hex distance ≤ radius from
  (q, r) and |dy| ≤ radius (y clamped to 0..127), in loaded columns, → `ctx.write(AIR)`, stopping at 'capped'. Message (`ok: true`):
  `no water to drain within R`, else `drained N water cell(s) within R` + ` — the water around it flows back in` (unedited sources were
  removed and water remains in the ring at R + 1 or the layer above) + ` (stopped: the world already has too many edited cells)` +
  ` (K column(s) not loaded)`.
- `currentAt(x, y, z, out)`: (x, y, z) = a body's feet + 0.1 (main adds it to the player's pull; pigs through `pigWorld.pullAt`). Zero
  unless the water switch is on; in FALL `[0, −WATER_CURRENT, 0]`; in FLOW_k `WATER_CURRENT` along the normalised sum of the directions
  (FACE_NORMALS) of the side neighbours with the lowest level below k (solid and UNLOADED cells skipped, non-water counts 0); else zero.
### 35.6 Saving and sinking
FLOW / FALL are never saved (§33.9: dropped when the origin is AIR or WATER, else AIR); the reseeder resumes the flow on load. A WATER
source is fall-through (§5): sand, gravel, debris and logs sink to the bottom and crush the water cell they land in; a hole left in a lake
refills as lake (rule 2a: natural water, whatever the floor), so no air pocket persists and the live world matches what a reload makes.

## 36. `src/support.js` and `src/trees.js` (PURE) — collapsing structures and falling trees, v0.8

Rationale and measurements: `docs/DESIGN-physics.md` §5–§6. The scheduler side (seeds, `support.step` in the tick) is §33.6.
```js
// support.js
export const COLLAPSE_TIP            // 'Builds must touch the ground! (Esc → Physics to turn collapse off)'
export function isLoadBearing(id)    // isSolid && !isLeaves && id !== RUNE_BLOCK   (UNLOADED, AIR, liquids, CAMPFIRE, BLACK_HOLE → false)
export function isSelfAnchored(id)   // RUNE_BLOCK or BLACK_HOLE: never fall, hold nothing up
export function isAnchorCell(world, q, y, r)   // y === 0 || BEDROCK || world.isNaturalGround(q, y, r)
export class SupportSolver {         // physics.support
  constructor(physics)               // registers the trigger 'support' (feature collapse, §36.1.5)
  get busy; tipSaid; stats { batches, searches, visits, floating, crumbled, toppled, restarts }
  step(ctx, seeds: SeedQueue, maxVisits) → visits; reset(); onSwitch(on)       // off → reset()
  cancelEvent(id) → 0; settleInto(overlay)                                       // undo / saving (§36.3.2, §36.6.4)
}
export const CRUMBLE_SLICE           // 64: a big crumble's cells between two deadline checks (§36.3.1)
export function peekNeighbours(world, q, y, r, out, chunk?) → out   // the 8 neighbour ids (6 sides, above, below) as peekBlock gives
                                     // them, read straight from the chunk when the cell is off its edges (one lookup, not eight)
/** FloatingComponent = { cells: [q, y, r, id][], cause: Cause, event: number } */
// trees.js (imports isLoadBearing from support.js)
export function tiltEuler(kx, kz, theta, out = [0, 0, 0]) → [rx, ry, rz]   // Euler 'YXZ' of a rotation by θ about axis (kx, 0, kz)
export function shakeAngle(t) → θ                                          // tilt t s into the shake (§36.5.3)
export class Trees {                 // physics.trees
  constructor(physics); maxToppling (= TREE_MAX_TOPPLING); get count (falling + waiting); get decayCount
  get jobs → { dir, phase: 'queued'|'shake'|'fall', theta, logs, cells, event }[]   // read-only view (tests, diagnostics)
  stats { toppled, impacts, decayed }
  test(component) → TreeInfo|null    // TreeInfo = { logs: [q,y,r,id][], leaves: [q,y,r,id][], cut: [q,y,r], pivot: [x,y,z] }
  topple(tree, component, { cause?, event? }) → boolean   // false → the caller crumbles the component
  decayHangingLeaves(cells, { event? }?) → n               // after a crumble (§36.6.1)
  step(dt); renderItems(push); settleInto(overlay); cancelEvent(id) → n; reset(); onSwitch(on)
}
```
### 36.1 Batches and the search
1. `step(ctx, seeds, maxVisits)`: when no batch is open and `seeds.size > 0`, a BATCH opens with a fresh memo (a supported set and a
   floating map) and takes the seeds pending at that moment (`seeds.shift()`, the priority lane first; over several ticks when there
   are thousands). Its start cells, in this order: each seed's `cells`, then the 8 neighbours of each of its `removed` cells (the
   queue leaves out cells already pending elsewhere) — generated from a cursor as the sweep goes and deduplicated by the memo; a
   removal whose 8 neighbours hold nothing load-bearing (inside a dug-out volume: one `peekNeighbours`) is passed over at once.
2. A start cell already in the memo is skipped; UNLOADED, or load-bearing and `isAnchorCell` → supported; not load-bearing →
   skipped. Otherwise a DFS starts from it: neighbours are pushed in the order above, the 6 sides (HEX_DIRS), below — so the cell
   below is popped first, then the sides, then the one above. A popped cell that is no longer load-bearing is skipped; else it counts
   one visit and each neighbour with y in 0..127 not pushed yet is checked: in the supported memo, UNLOADED, or load-bearing and an
   anchor → the search ends SUPPORTED; load-bearing → pushed. `SUPPORT_LIMIT` visits in one search → SUPPORTED. Empty stack →
   FLOATING.
3. SUPPORTED: every pushed cell joins the supported memo. FLOATING: the pushed cells are one component (with the seed of its start
   cell). A cell that already belonged to an earlier component marks that one stale. A verdict over more than 512 cells is written
   into the memo 512 at a time under the budget below, before the next start cell (a block placed next to such a component meanwhile
   still marks it stale).
4. Budget: EVERY part of a batch keeps a cursor and stops on the tick's budget (v0.8 review, CORE-1 / F1 / FR-2): taking seeds in,
   the start-cell sweep, the DFS, writing a verdict into the memo, the rule's passes (§36.2.5) and the collapse (§36.3.1). A step
   stops when `maxVisits` visits ran, when `maxVisits · 8` units of cheap work ran (a seed taken in, a start cell looked at, 8 per
   removal scanned by the rule, 1 per cell written into the memo), or when `ctx.now() ≥ ctx.deadline` — checked every 256 visits and
   every 256 cheap units, so a step always does at least that much. The batch, memo and the current DFS are kept (`busy` is true
   until the batch has collapsed what it found); when a batch ends and budget is left, the next one starts. A 30 000-removal
   `fill … air` batch takes ~10 ticks of ≤ 3 ms instead of one 150–400 ms tick.
5. Trigger 'support' (collapse): while a batch is open, an EXTERNAL write (mode `WRITE_EXTERNAL`) that makes a cell load-bearing
   restarts the current DFS when the cell touches one of its pushed cells (`stats.restarts`), and marks a found component next to it
   stale (never collapsed). Physics' own writes are ignored; removals need nothing (they seed the next batch).
### 36.2 Which components collapse (the disconnected-by-this-removal rule)
1. A removal `[q, y, r, prevId, wasAnchor]` of the batch is SUPPORTED when `wasAnchor === 1` or one of its 8 neighbours is in the
   supported memo or UNLOADED.
2. A (not stale) floating component next to a supported removal COLLAPSES; every removal next to a collapsing component or to a
   supported removal is supported too — propagated until nothing changes (several cells cut at once: area commands, craters).
3. A component found from a seed with no `removed` (an explicit `seedSupport`, e.g. a crater rim) collapses outright.
4. Every other floating component stays: a build that already floated (old saves, `fill`, physics-off builds) is never brought
   down by breaking one of its blocks. Placing blocks is never checked.
5. It runs as three resumable passes over the batch's removals (index them by cell; find the supported ones and the components each
   touches; spread through removals and components) — skipped when no component floated.
### 36.3 Collapse
1. Collapsing components are handled in the order they were found; after each one — and after each slice of a crumble —
   `ctx.now() ≥ ctx.deadline` leaves the rest for the next tick. A component of ≤ TREE_MAX_CELLS cells is re-read whole: only cells
   still load-bearing make the FloatingComponent `[q, y, r, id]` (none → skipped) for the tree test. A crumble goes CRUMBLE_SLICE
   cells at a time in (y, q, r) order (one numeric sort of `y·2^42 + packed column`), each slice re-read (cells no longer
   load-bearing are skipped): a big build comes down from the bottom over a few ticks — what is not down yet hangs meanwhile — instead
   of freezing one frame (an 8 000-cell box took 110–250 ms). It is committed once begun; later batches wait (`busy`).
2. Undo: the writes record into the seed's `event` while it is still `physics.lastEvent` (a blast's rim search records into the blast);
   otherwise into the batch's own event, opened once per batch with `beginEvent('collapse', seed.cause)` (later components and slices
   re-enter it; a big crumble chooses it at its first slice with a live cell). Its kind is `'falling tree'` while it holds only
   toppled trees and `'collapse'` once something crumbled. `cancelEvent(id)` (undo of that event, or of the event a pending collapse
   would record into) ends the batch: what still hangs stays where it is, like everything undo puts back.
3. `tree = trees.test(component)`; `tree && trees.topple(tree, component, { cause, event })` → `stats.toppled++`; else the crumble:
   each slice is `fallers.crumble(slice, { event, settle })`, where the lowest `max(0, n − free slots when it began)` cells of the
   whole component settle instantly and the rest animate (§34.2.4: the pile keeps its order across slices); once every cell is down,
   `trees.decayHangingLeaves` runs over the component's cells (256 at a time). The first slice that removed a cell counts
   `stats.crumbled++`, and the first such crumble of this SupportSolver (one per loaded world) says COLLAPSE_TIP (`tipSaid`). A
   BLAST_BARREL cell for which `ctx.explosions.hangBurning(q, y, r)` is true (it burns in place) is left out (integration, §38.2).
4. Rune blocks and black holes are never part of a component (not load-bearing): they stay where they are, and what rests on them
   lands on them. Campfires, water and anything else above follow through the normal triggers (§33.5). No boundary search follows a
   collapse: a component is maximal, so removing it cannot leave another load-bearing cell floating.
### 36.4 Tree test (`trees.test(component)`)
1. A tree has 3 … TREE_MAX_CELLS cells, every one a log (`isLog`), in at most 2 (q, r) columns that are hex-adjacent; anything else
   (a log cabin, a trunk with a plank platform) → null, and the component crumbles.
2. `logs` = the cells sorted by (y, q, r). `leaves` = every `isLeaves` cell in a column within hex distance TREE_LEAF_RADIUS of a log
   column, with y from the lowest log to the top log + TREE_LEAF_ABOVE, unless ANOTHER log column is strictly nearer: a log outside
   the tree's columns at hex distance < d_own (the leaf's distance to the nearest own column) and |dy| ≤ TREE_LEAF_ABOVE. Ties stay
   with this tree. logs + leaves > TREE_MAX_CELLS → null.
3. `cut` = the cell below the lowest log; `pivot` = `[q + r/2, lowest log y, r·HEX_ROW_SPACING]` of the cut column (its top centre).
### 36.5 Topple (`trees.topple`, `trees.step`)
1. `topple` returns false for a malformed TreeInfo, logs + leaves > TREE_MAX_CELLS, TREE_MAX_QUEUED trees already waiting, or when no
   log could be removed. Otherwise, inside `enterEvent(event)`, every log, then leaf, still holding its id is removed with
   `ctx.writeQuiet(AIR)` (a refused cell stays in the world and out of the tree); the tree becomes a JOB (every cell as its centre minus
   the pivot) and its surroundings are queued for leaf decay (§36.6.1). The job starts at once when fewer than `maxToppling` jobs
   shake / fall and none waits; else it WAITS, drawn standing. Waiting jobs start in order, one per TREE_QUEUE_GAP_S, as slots free.
2. Direction: the side direction j (FACE_NORMALS index 0..5) with the largest dot product with "away from" (first maximum): the
   cause's (x, z) for an explosion cause; else the player when within TREE_CAUSE_RANGE (3D, of the pivot) — the cause's position for a
   player cause, otherwise `hooks.player()`; else `floor(ctx.random()·6)`. The rotation axis is k = up × dir = (dz, 0, −dx).
3. A starting job SHAKES for TREE_SHAKE_S with `ctx.sound('creak', pivot raised by half the trunk)`; its tilt is
   `shakeAngle(t) = TREE_THETA0·u² + TREE_SHAKE_ANGLE·sin(2π·TREE_SHAKE_WOBBLES·u)`, u = t / TREE_SHAKE_S (ends at TREE_THETA0).
4. Then it FALLS from θ = TREE_THETA0, ω = 0: per frame `n = ceil(dt / TREE_SUBSTEP_S)` substeps of h = dt / n: `ω += (3·|GRAVITY| /
   2H)·sin θ·h`, `θ' = min(θ + ω·h, π/2)`, H = top log y + 1 − pivot y. Before θ' is accepted every LOG centre `pivot + R(θ')·offset`
   (Rodrigues about k) is tested: y < 0, or its cell (worldToHex, floor y) UNLOADED or solid and not leaves → IMPACT at θ (the last
   free pose). θ' = π/2 → impact there. Leaves never collide, so other trees' canopies never stop a fall.
5. Impact: each log, lowest first, snaps to the cell its centre is in when that cell is fall-through and not taken by another log;
   else to the first such cell on points 0.35 apart toward the pivot; else up the pivot column — and becomes `ctx.fallers.spawn(logId,
   q, y, r, { event })` (the trunk ends up lying on the ground along the fall direction). Each leaf emits `max(1,
   ⌊TREE_LEAF_PARTICLES / leaves⌋)` 'leaves' particles at its centre (`{ id, spread: 0.6 }`). Each body of `hooks.bodies()` whose
   centre (feet + height/2) is within TREE_KNOCK_RADIUS of a snapped log centre is knocked once: `hooks.knock(body, TREE_KNOCK_SPEED ·
   away (horizontal, from that log; the fall direction when on top of it), TREE_KNOCK_UP, …, logX, logZ)`. One `ctx.sound('thud')` at
   the middle log. Landing logs never bury a body (the faller landing rules, §34.2.3).
6. A job is frozen while the chunk of its cut column is unloaded; nothing moves while physics is paused (§33.1.1).
### 36.6 Leaf decay, drawing, saving, undo
1. Decay is queued (each cell once) after a topple for every leaf in a column within LEAF_DECAY_RANGE (hex) of a removed log column,
   with y within LEAF_DECAY_RANGE of the removed logs' span, that has no log at hex distance ≤ LEAF_DECAY_RANGE and |dy| ≤
   LEAF_DECAY_RANGE; and after a crumble (`decayHangingLeaves(cells)`) for every cluster of leaves next to the crumbled cells —
   connected through leaves (8-neighbourhood), ≤ TREE_MAX_CELLS — that touches no load-bearing and no UNLOADED cell (a hedge on the
   ground or a canopy held by its trunk stays). After a topple the same cluster test also runs on the removed logs and leaves
   (`decayHangingLeaves(cells, { naturalOnly: true })`), queuing only leaves with no edit: a canopy leaf that a trunk lying on the
   ground below kept from both rules above (it is "nearer another log", §36.4.2) does not float, and a player's leaves are never
   taken by it.
2. A queued leaf decays after `LEAF_DECAY_S·(0.15 + 0.85·ctx.random())` s: when it still holds its id, `ctx.writeQuiet(AIR)` inside
   `enterEvent(event)` and 4 'leaves' particles. Leaves never become falling blocks.
3. `renderItems(push)`: every job (falling, then waiting) pushes each cell at `pivot + R(θ)·offset` with `tiltEuler(kx, kz, θ)`, scale 1
   (θ: 0 while waiting, `shakeAngle` while shaking).
4. support's `settleInto(overlay)` (after fallers'): the cells the open batch decided to collapse but has not brought down yet — the
   rest of a crumble and the components after it — still load-bearing in the overlay are saved fallen, lowest first, down their
   columns (a burning barrel is explosions'). Trees' `settleInto(overlay)` (saving; never the live world): per job, its logs snapped
   like an impact at the current θ against
   `overlay.peek`, then lowest first moved up past non-fall-through cells and down while the cell below is fall-through, and
   `overlay.set` there (a column in an unloaded chunk is skipped); leaves are not saved; leaves waiting to decay are saved as AIR.
5. `cancelEvent(id)` (undo): removes the jobs (falling or waiting) and the leaf decays of event id; returns the jobs removed. `reset()`
   drops everything. `onSwitch(on)` does nothing: trees already out of the world finish their fall (the scheduler stops new seeds).
### 36.7 Deviations from DESIGN-physics §5–§6 (and why)
1. A batch is "every seed pending when it starts" (searched over as many ticks as it needs) rather than "the seeds of one tick": the
   memo has to outlive a tick for the resumable search; new seeds wait for the next batch's fresh memo.
2. The disconnected-by-this-removal rule propagates through the removals and components of a batch (§36.2.2): with several cells cut
   at once, a part held only through other cut cells would otherwise never be judged "was supported".
3. Seeds without `removed` collapse what they find (§36.2.3): §37's blast rim seed (`seedSupport(rim, { cause })`) carries no removals.
4. One undo event per batch, and a collapse found from a blast's rim records into the blast's event (§36.3.2): one undo restores
   everything one action brought down.
5. The tree test requires every cell to be a log (a trunk with planks attached crumbles); collisions use "solid and not leaves" so
   rune blocks and barrels stop a fall too.
6. Away from a blast takes precedence over the player (§7 "away from the blast" for trees a blast fells).
7. Waiting trees leave the world at once and are drawn standing (no stale floating tree the player can still edit), and the queue is
   capped (TREE_MAX_QUEUED, beyond → crumble) so a `fill air` through a forest cannot queue minutes of toppling.
8. The shake eases into TREE_THETA0 (no 7° jump when the fall starts).
9. Hanging leaves also decay after a crumble (§36.6.1): the design only decays leaves after a topple, which left leaf roofs floating.
10. The first-collapse tip is per loaded world (not saved — that would need a save field) and only for crumbles, not trees.
11. No boundary `seedSupport` after a collapse (DESIGN §10.3 suggested one): a floating component is maximal, so nothing load-bearing
    next to it is left without support by its removal.
12. Batches, searches and crumbles are spread over ticks part by part (§36.1.4, §36.3.1; review CORE-1, F1, FR-2): DESIGN §2 budgets
    only the DFS visits, which left the batch build, the rule and the collapse of one component unbounded.
13. Hanging canopy leaves also decay after a topple (§36.6.1): ownership (§36.4.2) and the topple decay count any log, so a trunk
    felled earlier and lying on the ground under a canopy kept single leaves floating (about one per 5 trees felled in a dense forest).
    Natural leaves only: the rules above already decide a player's leaves.

## 37. `src/explosions.js` (PURE) — blast barrels, v0.8

Rationale: `docs/DESIGN-physics.md` §7. Wired elsewhere: the 'ignite' trigger / reseeder (§33.4–§33.5), R / left-click / raycast /
flash / shake / bodies in main (§23), `ignite` (§26), the BLAST_BARREL block and tiles (§5, §15), `group` in resolveBodies (§31).
```js
export const BLAST_PROOF_IDS         // AIR, WATER, WATER_FLOW_1..6, WATER_FALL, BEDROCK, OBSIDIAN, RUNE_BLOCK, BLACK_HOLE
export function isBlastProof(id)     // BLAST_PROOF_IDS, UNLOADED or any liquid
export function blastRadius(n)       // min(BLAST_MAX_RADIUS, BLAST_RADIUS·∛max(1, n))
export const LIT_BARREL_GROUP = 'lit-barrel'
export class Explosions {            // physics.explosions
  constructor(physics)               // registers rule 'ignite' (misc, feature explosions, ids [BLAST_BARREL]) and trigger 'barrel-timers'
  lit: LitBarrel[]; timers: Map<packCell, LitBarrel>; blastCount; lastBlast: BlastInfo|null; get litCount (lit + timers)
  lightAt(q, y, r) → boolean; ignite(q, y, r) → { ok, message }
  isBurning(q, y, r) → boolean                  // a fuse timer burns in that cell (main's hint, §23)
  hangBurning(q, y, r) → boolean                // isBurning, and marks the timer `hung` (support.js asks before a crumble, §38.2)
  raycast(ox, oy, oz, dx, dy, dz, maxDist) → { target: LitBarrel, distance }|null; snuff(target) → boolean
  step(dt); renderItems(push) (nothing: lit barrels are tumblers, timers are blocks); bodies(out); settleInto(overlay)
  cancelEvent(id, write = ctx.writeQuiet-based) → BarrelUndo     // undo, AFTER the event's cells are restored (§33.8.4, §37.4.3)
  flash(out { x, y, z, intensity }) → out; shakeOffset(x, y, z, out [dx, dy, dz]) → out; reset(); onSwitch(on)
}
/** LitBarrel = { tumbler: Tumbler|null (null = fuse timer), q, y, r (entities: the cell it was LIT in), fuse (s left), event (blast
 *               that lit it — or caught it burning, §37.3.3 — 0 = none), phase, sparkIn, hung (timers: a collapse left it hanging,
 *               §38.2), hungEvent (timers: lastEvent's id when it was hung, 0 = none) }
 *  BarrelUndo = { putOut (lit barrels of the event stopped), burnt (not given back: a CAMPFIRE next to the cell), lost (no loaded
 *               cell with room in the column) }
 *  BlastInfo = { x, y, z, radius, barrels, destroyed, debris, lit (barrels it set burning), knocked, rim, capped, event } */
```
### 37.1 Lighting
1. `lightAt` (R; main wraps it in `asPlayer`): false while explosions are off. `_light(q, y, r)`: the cell must hold BLAST_BARREL and
   not already burn (no timer); while `lit.length < MAX_LIT_BARRELS` and `fallers.tumblerCount < MAX_TUMBLING`, `ctx.writeQuiet(AIR)`
   and `fallers.spawnTumbler(BLAST_BARREL, cell floor centre, 0, 0, 0, { persistent: true, event: 0, data: rec })` with
   `body.group = LIT_BARREL_GROUP`, fuse BARREL_FUSE_S, a 'hiss' and 6 sparks (a null tumbler puts the block back); otherwise a
   **fuse timer** in place (fuse BARREL_FUSE_S; the block stays). Quiet: lighting never seeds a support search.
2. Rule 'ignite' (`misc`): a barrel with a CAMPFIRE among its 8 neighbours → `_light`; no campfire but an UNLOADED neighbour → park.
3. `ignite(q, y, r)` (console / rune): `{ ok: false }` with `explosions are off — …`, `cell … is not loaded`, `there is no blast barrel at
   (q, y, r)`, `the barrel at (q, y, r) is already burning`; else `lit the blast barrel at (q, y, r) — 3 s fuse`.
4. `_addTimer(q, y, r, fuse, event)`: an existing timer keeps the SHORTER fuse and, when `event > 0`, takes that event (a barrel lit by R,
   a campfire or `ignite` that a blast catches joins the blast's chain: one undo, §37.3.1); at most MAX_FUSE_TIMERS (beyond: stays
   unlit). Trigger
   'barrel-timers': a cell that stops being BLAST_BARREL drops its timer (broken, crumbled, swallowed barrels stop burning).
### 37.2 Lit barrels per frame (`step(dt)`, after fallers and trees; nothing while paused)
1. Entities: a tumbler no longer in `fallers.tumblers` (fell below y = −16, reset) is forgotten; frozen while its column is unloaded;
   WATER-family at `floor(y + 0.1)` or `floor(y + 0.6)` of its column → put out (steam). Else `fuse −= dt`; pulse `scale = 1 +
   BARREL_PULSE_SCALE·sin(phase)`, phase at BARREL_PULSE_HZ × (1 + 2·min(1, 1 − fuse)) over the last second; 2 sparks at the lid every
   0.12 s. Timers (loaded only): `fuse −= dt`, 1 spark every 0.2 s (≤ 24 per frame).
2. Every BARREL_HISS_S one 'hiss' (volume 0.7) at the burning barrel nearest `hooks.player()`.
3. **Merged chains**, ≤ MAX_EXPLOSIONS_PER_FRAME per frame: the loaded barrel with the smallest fuse; if that fuse ≤ 0, the group = every
   loaded barrel (entities and timers) with `fuse ≤ earliest + BLAST_CHAIN_WINDOW_S` whose centre (entity: body centre; timer: cell
   centre) is within BLAST_CHAIN_DISTANCE of the earliest's. Timers whose cell is no longer a barrel are dropped; timers with water above
   or beside them fizzle (8 steam each for the first 16 of the group; ONE 'fizzle' per group, at the fizzled timer nearest
   `hooks.player()`, emitted AFTER the group's blast — a wet pile sent ~100 fizzles in one frame and they took every audio voice from
   the boom; main also throttles 'fizzle', §23); the rest go off as ONE blast at the mean centre, radius `blastRadius(n)`.
4. **Putting out** (`snuff`, water, switch off): the tumbler is removed, 'fizzle' + 8 smoke (steam when wet), and a BLAST_BARREL is left
   (outside any event — not in the event of a blast that caught it, whose undo would take it away without giving it back)
   in the first fall-through or liquid cell at `floor(y + 0.05)` … +3 of its column: over a fall-through cell → `fallers.spawn` (it
   drops); in a fall-through cell → `fallers.settleNow` (never buries a body). Water is fall-through (§35.6), so a barrel put out
   in a lake sinks to the bottom; `ctx.write` into the cell remains only as the fallback for any other liquid.
### 37.3 The blast (`_explode` → `_blast`)
1. Event: when a barrel of the group was lit by the blast that is still `physics.lastEvent`, the writes go into THAT event (`enterEvent`:
   a chain is one undo); else `beginEvent('explosion', { kind: 'explosion', x, y, z })`. The group's entities are removed (the cells
   they were LIT in kept for the undo refund — not where they went off: two lit in one stack fall into one cell, a knocked one goes
   off in mid-air) and its timer cells written AIR (quiet).
2. Cells: every column within `R + BLAST_JITTER` horizontally that is loaded, y within reach; a cell whose centre distance d satisfies
   `d ≤ R + jitter`, `jitter = (hash3(q, y, r, salt) / 2^32 · 2 − 1) · BLAST_JITTER` with `salt` from `ctx.random()` once per blast, and
   that is not blast-proof, is a candidate; candidates are handled NEAREST FIRST: BLAST_BARREL → `_addTimer(fuse ∈
   [BARREL_TIMER_FUSE_MIN_S, MAX_S) seeded, event)`; anything else (campfires and leaves included) → `ctx.writeQuiet(AIR)`; the first
   `'capped'` stops all further breaking (barrels still catch).
3. Bodies within 2R: `j = BLAST_IMPULSE·(1 − d/2R)` with d from the blast centre to the body centre (feet + height/2), along the unit
   direction (straight up when d ≈ 0), `vy = max(j·ny, BLAST_MIN_UP)`. The player and pigs (`hooks.bodies()`) through
   `hooks.knock(body, vx, vy, vz, cx, cz)` (main: pigs squeal and flee); every tumbler (lit barrels, debris) gets it added directly
   (`onGround = false`, ± DEBRIS_SPIN/2 spin about x and z). A knocked body riding a knocked carrier (`body.carrier`, §31) then has the
   carrier's `vx, vz` change taken off again — a rider's velocity is relative to its carrier, so it ends up with exactly its own
   impulse over the ground, not its own plus the carrier's (a player on a pig was thrown ~2.5× as far; all changes are taken
   before any is corrected). A lit barrel whose centre is within R gets `fuse = min(fuse, a timer fuse)` and `event` = the blast's
   (it joins the chain like a barrel block caught as a timer). Column fallers are not pushed.
4. Debris: up to MAX_DEBRIS destroyed SOLID cells, picked at random (`ctx.random`), become tumblers of their block (feet at y + 0.01,
   outward from the centre at DEBRIS_SPEED_MIN…MAX, up DEBRIS_UP_MIN…MAX, spin ±DEBRIS_SPIN, event = the blast's): they vanish in dust
   where they land (§34.3); a null tumbler → 6 dust. Of the other destroyed cells an even spread of at most BLAST_DUST_CELLS puffs 3 dust
   (campfires: smoke).
5. Support: ONE `physics.seedSupport(rim, { cause, removed })` inside the event — `rim` = every load-bearing, not destroyed 8-neighbour of
   a destroyed cell; `removed` = `[q, y, r, prevId, wasAnchor]` for each destroyed load-bearing cell (and each timer barrel, wasAnchor 0),
   wasAnchor = `isAnchorCell` read before the write. Trees the collapse fells topple away from `cause` (§36).
6. Effects: 'boom' at volume `min(1, 0.6 + 0.4·(R − BLAST_RADIUS)/(BLAST_MAX_RADIUS − BLAST_RADIUS))`; `16 + 8R` smoke (spread 0.5R, speed ×2.2)
   and `24 + 6R` sparks (speed ×1.6) at the centre. `flash(out)`: position = centre + (0, 1, 0), intensity `BLAST_FLASH_INTENSITY·R/BLAST_RADIUS·(1 −
   age/BLAST_FLASH_S)²` (0 outside); `shakeOffset`: `a = BLAST_SHAKE_AMPLITUDE·√(R/BLAST_RADIUS)·(1 − d/BLAST_SHAKE_RANGE)·(1 −
   age/BLAST_SHAKE_S)²`, `out = a·[sin(53t + 0.7), 0.6·sin(61t + 2.1), sin(47t + 4.2)]` (t = age). Ages run on step(dt) time, so a pause
   freezes them. `blastCount++`, `lastBlast = BlastInfo`.
### 37.4 Bodies, saving, undo, switches
1. `bodies(out)` pushes every lit entity's body (`group = LIT_BARREL_GROUP`, so resolveBodies never pairs two of them).
2. `settleInto(overlay)`: each lit entity is saved as BLAST_BARREL at `floor(y + 0.05)` moved up past cells that are neither fall-through
   nor liquid, then down while the cell below is fall-through (unloaded columns skipped); fuse timers are not saved (they are barrels),
   except that a `hung` timer's barrel, lowest first, is saved moved down its column while the cell below is fall-through (§38.2).
3. `cancelEvent(id, write)` (undo, AFTER the scheduler restored the event's cells, §33.8.4; `write(q, y, r)` writes a BLAST_BARREL
   block — undo passes its quiet uncapped write): timers of event `id` are dropped (still barrels; a `hung` one queues
   `physics.seedSupport([[q, y, r]])`, §38.2) and lit entities of it are removed — except one whose cell (an entity: its lit cell) has a
   CAMPFIRE neighbour, which keeps burning with `event = 0` (put out it would only catch again); `putOut` counts the rest. Then every
   barrel to give back — the entities used up by the event's blasts and the entities just removed — goes back into the cell it was
   LIT in, lowest first: moved up past cells that are neither AIR nor water (sand that dropped into the cell, a barrel given back
   there already: two from one stack come back stacked), then down while the cell below is AIR or water (never floating); an
   unloaded column or one full to the top → `lost`; a CAMPFIRE next to the final cell → not given back (`burnt`, §33.8.4);
   else `write`.
4. `onSwitch(false)`: every lit entity is put out (37.2.4), every timer dropped (a `hung` one queues its support seed, §38.2). A timer
   that fizzles in water (37.2.3) does the same. The hung seed joins the undoable event (`withEvent`) while `canUndo` and that event is
   the timer's `event`, its `hungEvent`, or recorded a cell next to the barrel (a collapse begun just after `hangBurning`): the barrel's
   fall belongs to what left it hanging. Otherwise its crumble began a 'collapse' event of its own, which replaced the blast as the one
   undoable event — the crater could no longer be undone. `reset()`: lit entities removed from the fallers, timers,
   refunds, flash and shake cleared.

## 38. Block physics integration (v0.8) — the features together

The five feature modules were built in parallel against stubs of each other (DESIGN-physics §10). These rules are what their
combination needs on top of §33–§37; `tests/integration/physics.test.js` checks each of them headless (Map-backed fake worlds, plus a
real World for saving and reloading).
### 38.1 Wiring (as merged)
1. Construction order in `BlockPhysics`: fallers, fluids, support, trees, explosions. Rings: `fall` = ['gravity', 'water'], `water` =
   ['water'], `misc` = ['ignite']. Triggers, in order: 'gravity', 'water', 'ignite' (built in), 'water-floor' (fluids), 'support'
   (collapse), 'barrel-timers' (explosions). Reseeders: 'gravity', 'water' (fluids' replacement), 'ignite'.
2. Shared files: `audio.js` has ONE `playCreak` (the trees feature's sawtooth groan; the explosives branch's copy was dropped) beside
   `playThud`, `playSplash`, `playBoom`, `playHiss`, `playFizzle`; `config.js` keeps one "Block physics" section with a block per
   feature; main's frame order is §23 / DESIGN §9 unchanged.
3. Water is fall-through (§35.6): sand, crumble pieces, logs and put-out barrels sink to the bottom of a lake and crush the source they
   land in; a lit barrel entity in any water cell goes out (§37.2.1) and its barrel block sinks the same way.
### 38.2 Barrels burning in place and collapses
1. A blast that sets barrels burning (fuse timers, §37.3.2) usually also cuts what holds them up, and the rim search (§37.3.5) runs a
   tick later — before the 0.3–0.8 s fuses end. `support._collapse` asks `explosions.hangBurning(q, y, r)` for every BLAST_BARREL cell
   of a collapsing component: a burning one is left out of the crumble and stays where it is (marked `hung`) until it goes off; the
   rest of the component crumbles around it (what rested on it lands on it). Without this the crumble removed the barrel cell, the
   'barrel-timers' trigger dropped its fuse, and a pile caught by a blast landed in the crater as dead barrels.
2. A `hung` timer that stops burning WITHOUT going off — fizzled by water (§37.2.3), explosions switched off (§37.4.4), undo
   (§37.4.3) — queues `physics.seedSupport([[q, y, r]], { cause: { kind: 'physics' } })`: a seed without removals collapses the
   floating component it finds outright (§36.2.3), so the barrel falls after all instead of floating forever. The seed is queued
   inside the blast's event while that is still undoable (§37.4.4), so the crumble records into it (§36.3) instead of opening a
   'collapse' event that would take the undo away from the crater.
3. Saving (§37.4.2): a `hung` timer's barrel is saved dropped down its column (a reloaded barrel has no fuse and would float).
4. main's crosshair hint on a burning barrel: `Blast Barrel · burning! click: break it` (`explosions.isBurning`); breaking it drops its
   fuse ('barrel-timers').
### 38.3 Water, craters and undo
1. Blast writes are quiet (no support seed of their own) but every trigger still runs, so the 'water' / 'water-floor' triggers queue
   the water next to a crater and it flows in (a crater beside the sea or a pond floods; sources form by the ≥ 3 rule).
2. `undo()` (§33.8.4) also restores a recorded cell the event made AIR when it now holds water (any water-family id): the crater fills
   back in instead of leaving pockets of water inside the restored ground, and the drained flow edits prune away.
3. What the GRAVITY rule moved after a blast or a collapse (sand from a crater rim) is not part of the event: it stays where it fell, and
   a crater cell it fell into is reported as `changed since, left alone`. One undo restores the blast, the collapse it caused (§36.3.2)
   and the trees it felled; a chain is one event (§37.3.1) — including the barrels it caught that were already burning (§37.3.3,
   §37.1.4) and the fall of hung barrels that fizzled (§38.2.2) — and gives the lit barrels back in their lit cells (§37.4.3), never
   next to a campfire (§33.8.4).
### 38.4 Scheduling
1. The fall ring carries falling water as well as gravity blocks (§33.5.2), so a long waterfall can spend the whole tick budget.
   Fair shares (§33.1.3) replaced the support-only starvation guard (SUPPORT_STARVE_TICKS): the fall ring stops at half the budget
   while misc, support or water have work due, every ring with due updates gets at least a small slice, and support gets a step every
   tick (SUPPORT_STARVED_VISITS visits when the rings overran) — measured with a 631-source rain at y = 125 (seed 42): a new source
   beside it flows after 12–13 ticks (was 443–461) and a barrel by a campfire lights after 1 tick (was 438–456); a cut tree next to
   a waterfall falls at once.
2. Measured (headless Chrome in real time on a loaded machine, seed 42, 200 barrels from one `fill`, one lit): 5 merged blasts (1, 15,
   110, 69, 1 barrels; 4 barrels at the far corner of the box are never in reach and stay), physics step worst 22–25 ms (the
   radius-8 blast's ~700 writes) and mean ≈ 0.7 ms, world.update worst 13–15 ms (lazy re-meshing), whole frame worst 40–94 ms with
   headless software rendering.
3. Measured after the review's performance pass (Node, real worldgen, seed 42, on a shared machine with 4–11 ms GC pauses): a
   32 768-cell `fill … air` in stone — worst physics step after the job 5–10 ms (was 150–470 ms), area-job writes ~1–2.5× their
   pre-v0.8 per-cell cost (were ~8×); a cut 37 × 64 / 217 × 40 sand tower — worst tick 4–14 ms (was 34–113 ms), no frame over 16 ms;
   an 8 000-cell floating box crumbling — worst physics step ~6 ms warm (was 110–243 ms), down over ~3 s; a 15 000-cell sand
   `fill` in the air — no tick over 16 ms (were 10 per run). Final column stacks equal the old code's in every one of these.

## 24. Test fixtures (`tests/helpers/fixtures.js`, already written)

`makeGetBlock(map, fill = AIR)` (map keyed `"q,y,r"`), `makeChunkDataGetter(chunks)` (Map keyed chunkKey → ChunkData|Chunk),
`makeChunkData()` (zeroed ChunkData), `setWorldBlock(chunks, q, y, r, id)`, `flatIsSolid(groundY)`, `flatGetBlock(groundY, id = STONE)`,
`countFaces(meshData)` (sum of `faceCount` over layers), `trivialWorldGen()` (all-AIR chunks with heights 0, biome PLAINS),
`flatWorldGen(groundY, id = STONE)`.
v0.8: `makeFakeWorld({ groundY = −1, groundId = STONE, seed, now })` — a Map-backed world with World's physics surface (peekBlock,
getBlock, setBlock(…, lazy) with edits / origins / pruning / editCount, hasChunkAtCell / hasChunkAt, hasEdit, originAt,
terrainHeightAt, isNaturalGround, onBlockChange, onChunkGenerated), a `writes` log, `unload(cq, cr)` / `load(cq, cr)` (fires
onChunkGenerated) and `put(q, y, r, id)` (terrain without an edit or hook); `attachPhysics(world, BlockPhysics, hooks?, opts?)`
forwards onBlockChange / onChunkGenerated like main.

## 25. Pitfall checklist (read before coding)

1. Floor/mod for negatives (see §0). `-1 % 16 === -1` in JS. `hexRound` must never return −0.
2. World positions vs cell coordinates: never `Math.floor(x)` a world coordinate to get a cell — use `worldToHex(x, z)`.
3. Chunk-edge culling reads neighbours via `getChunkData`; mesh only when all 6 HEX neighbours exist (world.js); the index-space
   corner chunks `(±1, ±1)` are not neighbours — do not wait for them and do not read them.
4. AO quad flip: diagonal joins the brighter pair; do not "fix" one order by reversing it. Cap faces are fans with a centre vertex.
5. Water top: lower ALL top vertices of a water cell with non-water above (six side quads and the top hexagon) to
   `waterSurfaceHeight`; never draw faces between two water cells except the strip of the higher surface above the lower one.
6. Leaves and glass are cutout (`alphaTest 0.5`, depth write on). Water is the only translucent layer.
7. Texture bleeding: NearestFilter both filters, no mipmaps, `UV_INSET`; cap UVs stay inside the tile because the hexagon is inscribed (`TOP_UV_SCALE`).
8. `flipY = false` ⇔ the UV assignment in §10.2 (v1 at the bottom of side quads; +z → +v on caps).
9. Colour spaces: atlas `colorSpace = SRGBColorSpace`; `Color.setRGB(r,g,b, SRGBColorSpace)` for spec colours.
10. Physical light units: no `useLegacyLights`; sun ≈ 2 at noon, hemisphere ≈ 1.4.
11. Unloading: `scene.remove` + `geometry.dispose()`; never dispose shared materials/texture.
12. Pointer lock only from a user gesture; catch promise rejections; clear key state on unlock/blur.
13. dt: clamp to `MAX_FRAME_DT`; sub-step physics; use the rAF timestamp.
14. `getBlock` returns AIR in unloaded chunks → guard physics with `world.hasChunkAt` (WORLD position).
15. Apply saved edits right after `generateChunk`, before the chunk is visible to `getBlock`.
16. Indices are `Uint32Array` with `indexCount` entries (not `faceCount * 6`); hand Three `new BufferAttribute(indices, 1)`.
17. Never bind Ctrl (`Ctrl+W` closes the tab). Sprint is double-tap W.
18. Column arrays use `lq*16 + lr`.
19. Tree validity depends only on `getColumn` — never on chunk block data.
20. `PLAYER_RADIUS < HEX_SIZE / 2` (hence `< HEX_INRADIUS`) is what lets the player through 1-cell passages and makes the 7-column
    collider exact; do not widen the player without revisiting physics. Horizontal moves must END overlap-free (refuse, never
    leave a residual) or the vertical sweep turns the residual into a snap through walls.
21. Streaming distances are HEX distances in chunk coordinates measured between chunk ORIGIN cells, so the meshed region is
    off-centre by up to one chunk footprint; the fog far must stay below `(rd − 1)` rings (`fogRangeForRenderDistance`).
22. Every block write goes through `World.setBlock` so `onBlockChange` keeps the rune store and black holes honest; never write `chunk.blocks` directly
    from gameplay code. Area commands skip RUNE_BLOCK cells and are never allowed to mint rune blocks.
23. Rune scripts use `@` for their own cell; `~` is the player. A chain fan-out is bounded by the wave rule (once per activation), not by
    the hop cap. Runner state is never persisted. Repeat/step/chain are suppressed after `stopall` until an interact/console trigger.
24. Modal states (picker, console, editor) are set BEFORE `controls.unlock()`; closing goes through `enterPlayingFromModal()`.
25. (v0.8) Physics never writes `chunk.blocks` or calls `world.setBlock` directly: rules use `ctx.write` / `ctx.writeQuiet` (lazy,
    capped, event-recorded). Read through `ctx.peek` and treat `UNLOADED` as "not there yet" (park), never as AIR.
26. (v0.8) Physics modules are PURE: no `Math.random` (use `ctx.random()`), no clocks (use `ctx.now()` / `ctx.deadline`), no audio
    or three — effects go through `ctx.sound` / `ctx.particles` / hooks. Feature modules never import blockphysics.js.
27. (v0.8) Saving never mutates the live world: build saves with `blockPhysics.exportEdits()` (a copy with fallers settled), never by
    landing entities "for real".
28. (v0.8) A switched-off feature DROPS its triggers; switching it back on must never act on what happened meanwhile.
