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
>
> **Save slots.** Up to six worlds, one localStorage key each, listed on the title screen's Worlds panel (§41); the old single
> save moves into slot 1.
>
> **v0.9 — Survival.** A per-world Creative / Survival mode (§42): the body (§45), items, the pack and containers (§43),
> harvesting (§44), making and fire (§46), world generation 2 (§47), the survival screens, rendering and sound (§48) and main's
> wiring (§49). Design: `docs/DESIGN-survival.md`. Creative and every existing world behave exactly as before.

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
  (v0.9 note: on a picture seen from above with +X right and +Z down — north up — increasing angle from +X toward +Z, and so
  increasing face and corner index, turns CLOCKWISE. The indices and angles are what is normative; "clockwise from the north corner"
  in §48 means corners 5, 0, 1, 2, 3, 4.)
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
| `src/storage.js` | PURE (storage injected); save slots (§41) | A-storage | `tests/unit/storage.test.js`, `tests/unit/saveSlots.test.js` |
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
| `src/zombies.js` | PURE, zombies: spawning, AI, daylight, hits (§39) | zombies | `tests/unit/zombies.test.js` |
| `src/zombieRenderer.js` | three, instanced four-prism zombie models (§39.2) | zombies | `tests/unit/zombieRenderer.test.js` |
| `src/watcher.js` | PURE, the Hollow Watcher: sightings, placement, vanishing, traces (§40) | watcher | `tests/unit/watcher.test.js` |
| `src/watcherRenderer.js` | three, the Watcher's figure — hollow hex rings, hex lantern with fog-free lights, smoke wisp — and its shader pre-warm (§40.4) | watcher | `tests/unit/watcherRenderer.test.js` |
| `src/atlas.js` | DOM + three | A-atlas | — |
| `src/renderer.js` | three | A-renderer | `tests/unit/renderer.test.js` |
| `src/controls.js` | DOM | A-controls | — |
| `src/hud.js` | DOM | A-hud | — |
| `src/menus.js` | DOM (+ pure Worlds-panel text helpers, §41) | A-menus | `tests/unit/worldsMenu.test.js` (helpers), `tests/unit/styles.test.js` (layout) |
| `src/audio.js` | DOM (WebAudio) | A-audio | `tests/unit/explosionsAudio.test.js` (v0.8 feature sounds) |
| `src/diagnostics.js` | DOM | A-diagnostics | — |
| `src/console.js` | DOM | v0.3 | — |
| `src/runeEditor.js` | DOM | v0.3 | — |
| `src/main.js` | DOM glue | A-main | `tests/integration/harness.test.js`, `tests/integration/survival.test.js` |
| `src/items.js` | PURE, the item registry, tiers, tags (§43) | v0.9 W0 | `tests/unit/items.test.js` |
| `src/inventory.js` | PURE, `Pack`, `slotClick`, stacks, spoilage (§43) | v0.9 B | `tests/unit/inventory.test.js` |
| `src/containers.js` | PURE, baskets and belongings (§43) | v0.9 B | `tests/unit/containers.test.js` |
| `src/harvest.js` | PURE, BLOCK_RULES, break times, drops, picking, tapping, regrowth, mob drops (§44) | v0.9 B | `tests/unit/harvest.test.js` |
| `src/survivalControl.js` | PURE, dig / use state machines, the R priority, belongings cell, pack view (§44) | v0.9 B | `tests/unit/survivalControl.test.js` |
| `src/crafting.js` | PURE, RECIPES, findStations, listRecipes, CraftQueue lanes (§46) | v0.9 C | `tests/unit/crafting.test.js` |
| `src/cooking.js` | PURE, FIRE_TRANSFORMS, FireSlots (spots and fuel) (§46) | v0.9 C | `tests/unit/cooking.test.js` |
| `src/climate.js` | PURE, air / felt / body-target temperature, heat sources, salinity (§45) | v0.9 D | `tests/unit/climate.test.js` |
| `src/vitals.js` | PURE, stat dynamics, status, damage formulas (§45) | v0.9 D | `tests/unit/vitals.test.js` |
| `src/survival.js` | PURE, `Survival`: mode, vitals, step, death and waking, export (§45) | v0.9 D | `tests/unit/survival.test.js` |
| `src/itemArt.js` | PURE pixel painters, one 16 × 16 icon per non-block item (§48) | v0.9 E | `tests/unit/itemArt.test.js` |
| `src/itemIcons.js` | DOM, the item icon sheet (§48) | v0.9 E | — |
| `src/packUI.js` | DOM (+ pure geometry / label helpers), the Pack & Making screen (§48) | v0.9 E | `tests/unit/packUI.test.js` |
| `src/handbook.js` | PURE, the Survival Handbook's chapters (hand-written prose + tables generated from the data), `ensureHandbook` (§43) | v0.9 H | `tests/unit/handbook.test.js` |
| `src/handbookUI.js` | DOM (+ pure page layout helpers), the two Handbook readers: the Guide and the field book (§48) | v0.9 H | `tests/unit/handbookUI.test.js` |
| — | survival data closure, first day, harness (§42–§49) | v0.9 I | `tests/integration/survivalData.test.js`, `tests/integration/survival.test.js` |
| `tests/helpers/fixtures.js` | test helpers | Wave 0 (done) | — |
| `tests/helpers/fakeDom.js` | a small fake DOM for the DOM modules under Node (v0.9 E) | v0.9 E | — |

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
commands                           → config, coords, hex, blocks, physics, daynight (formatTime), watcher (WATCHER_HEIGHT)
runes                              → config, coords, hex, blocks, commands, physics
fluids, support, trees, explosions → config, blocks (+ hex, coords, physics as needed); never blockphysics
trees                              → … and support (isLoadBearing)
explosions                         → … + noise (hash3), support (isLoadBearing, isAnchorCell)
fallingblocks                      → config, blocks, hex, physics
blockphysics                       → config, blocks, hex, coords, noise (mulberry32), fallingblocks, fluids, support, trees, explosions
fallingRenderer                    → blocks (BLOCK), mesher (buildCellMesh), three
particles                          → config, blocks, tiles (averageColor, paintTile), mesher (BIOME_TINT, isTintedFace), three
mesher                             → config, coords, hex, blocks
worldgen                           → config, coords, hex, blocks, noise
world                              → config, coords, hex, blocks, chunk, noise (normalizeSeed), worldgen, mesher
storage                            → config, blocks (DEFAULT_HOTBAR), runes (normalizeRunesJSON, validateRunesJSON)
atlas                              → config, blocks, hex, tiles, three
renderer                           → config, hex, three
controls                           → config
hud                                → config, blocks, atlas
menus                              → config, blocks, atlas, storage (defaultWorldName)
audio                              → blocks
diagnostics                        → config, blocks, coords, hex, runes (runeKey)
console                            → config
runeEditor                         → config, commands (parseScript)
zombies                            → config, physics, hex, blocks, pigs (fireAhead, shoreYaw, isOpen, wrapAngle, SWIM_REAIM_S)
zombieRenderer                     → config, blocks (TILE), zombies (SWING_S), three
watcher                            → config, hex, blocks, raycast, physics (playerIntersectsBlock), daynight (isDayTime), support (isLoadBearing)
watcherRenderer                    → config (ATLAS_TILE_PX, TILE_UV), blocks (TILE, tileToUV), watcher (WATCHER_EYE_Y), three
main                               → everything except three (renderer, atlas, pigRenderer, campfireRenderer,
                                     fallingRenderer, particles, zombieRenderer and watcherRenderer are the three-importing
                                     modules)
# v0.9 Survival (§42–§49). Beyond DESIGN-survival §9.1, these edges were adjudicated in (all leaf-ward; still acyclic):
#   harvest → coords (forEachEditedCell), survivalControl → hex (HEX_DIRS), containers → inventory (stack helpers),
#   vitals → blocks, climate (soft landings, bodyTarget), climate → hex (hexToWorld), particles → tiles (paintTile).
items                              → blocks
inventory                          → config, items
containers                         → config, blocks, inventory
harvest                            → config, blocks, items, coords
survivalControl                    → config, blocks, items, harvest, hex
crafting                           → config, blocks, hex, items         (pack access through PackOps only)
cooking                            → config, blocks
climate                            → config, blocks, hex
vitals                             → config, blocks, climate
survival                           → config, items, vitals, climate
itemArt                            → (nothing)
itemIcons                          → config, items, atlas, itemArt
packUI                             → config, items            (the ItemIcons are handed in by main)
storage                            → … + items, cooking (fire-spot validation)
commands                           → … + items
hud                                → … + items, itemIcons
handbook                           → config, blocks, items, crafting, harvest, climate, vitals, cooking (read-only data and pure functions)
handbookUI                         → handbook (buildChapters, inlineParts)
main                               → … + all of the above, handbook and handbookUI (static imports, §49)
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
START_TIME, AUTOSAVE_INTERVAL_S, HOTBAR_SIZE, VERSION`; save slots (§41): `SAVE_SLOTS = 6, MAX_WORLD_NAME_CHARS = 24,
STORAGE_QUOTA_ESTIMATE = 5 * 1024 * 1024`.
`VERSION = '0.9.0'`; `package.json` and `package-lock.json` carry the same version and the title footer in `index.html` reads
`Caelancraft v<major>.<minor>` (`v0.9`) — bump all four together (wave0.test.js checks they agree). Render/data/unload radii are
**hex distances** in chunk coordinates. `FACE_SHADE` moved to `hex.js` (it derives from the face normals).
`TOP_UV_SCALE = √3/2` (hex caps are inscribed in their tile).
Commands / runes: `GAME_SECONDS_PER_DAY, MAX_FILL_CELLS, MAX_TOTAL_EDITS, MAX_CELLS_PER_FRAME, MAX_COMMANDS_PER_FRAME,
MAX_RUNNING_SCRIPTS, MAX_CHAIN_HOPS, CHAIN_DELAY_S, MAX_RUNES, MAX_RUNE_SCRIPT_CHARS, MAX_RUNE_SCRIPT_LINES, MAX_RUNE_LABEL_CHARS,
WAIT_MIN_S, WAIT_MAX_S, REPEAT_MIN_S, REPEAT_MAX_S, STEP_COOLDOWN_MAX_S, AREA_MAX_RADIUS, AREA_MAX_HEIGHT, MAX_CONSOLE_LINES,
CONSOLE_HISTORY, CHAT_LINES, CHAT_LINE_MS` (values in the file; §26–§28 use them by name).
Block physics (v0.8, §33–§38): `PHYSICS_TICK_S, WATER_TICKS, PHYSICS_TICK_BUDGET_MS, MAX_CELL_UPDATES_PER_TICK,
MAX_SUPPORT_VISITS_PER_TICK, SUPPORT_STARVED_VISITS, MAX_PARKED_UPDATES, MAX_PENDING_SUPPORT_SEEDS, LAZY_COALESCE_UPDATES,
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
v0.9 Survival (section "Survival (§42–§49)", values per DESIGN-survival §9.2): `GEN_LATEST 2; PACK_SLOTS 27, WEAR_SLOTS 3, BASKET_SLOTS
18, REMAINS_SLOTS 30, MAX_CONTAINERS 1024; FIRE_SPOTS 7, MAX_FIRE_SLOTS 256; CAMPFIRE_FUEL_START_S 300, CAMPFIRE_FUEL_MAX_S 1200,
FUEL_STICK_S 40, FUEL_LOG_S 300, RELIGHT_HOLD_S 3; STATION_RANGE 3, STATION_WORK_RANGE 16, MAX_CRAFT_JOBS 8; STAT_MAX 100, BREATH_MAX_S
20, BREATH_REFILL_PER_S 5; BODY_TEMP_NORMAL 37, BODY_TEMP_MIN 25, BODY_TEMP_MAX 45, SICK_MAX_S 600, HEAL_MAX 50; FALL_SAFE_SPEED 13.5,
FALL_DAMAGE_K 0.1, CRUSH_DAMAGE_PER_CELL 6; ATTACK_REPEAT_S 0.55, DIG_TICK_S 0.25, USE_REPEAT_GAP_S 0.25, GULP_GAP_S 0.5, TAP_HOLD_S 4;
PIG_HEALTH 5, PIG_REPOP_CHECK_S 150, PIG_REPOP_TARGET 3, PIG_REPOP_RADIUS 64, PIG_REPOP_MIN 24, PIG_REPOP_MAX 48; ZOMBIE_DAMAGE 8,
FIRE_BURN_DAMAGE 4; REGROW_MEAN_S 600, MAX_REGROW_TRACKED 4096`. HOTBAR_SIZE (9) is also the pack's hotbar.

## 3. `src/types.js` (exact — already written)

Typedefs: `BlockId, ChunkKey, FaceIndex (0..7), RenderLayer, Vec3, GetBlockFn ((q, y, r) → BlockId), ChunkData, GetChunkDataFn
((cq, cr) → ChunkData|null), MeshData (+ indexCount), ChunkMeshData, RaycastHit ({q, y, r, face, nx, ny, nz, distance, blockId}),
ColumnInfo, WorldGen (getColumn(q, r), generateChunk(cq, cr)), PlayerState, PlayerInput, SkyState, EditsJSON, Rune, RunesJSON,
SaveData (version 2, optional `runes`), SmokeResult, GameContext (+ runCommand, runes, runner)`. Import in JSDoc as `/** @typedef {import('./types.js').MeshData} MeshData */`.
v0.9: `ItemStack, ItemDef, ToolDef, FoodDef, WearDef, SurvivalJSON, ContainersJSON, FireSlotsJSON`; `SaveData` gains `gen?, mode?,
survival?, containers?` and `version: 2|3`; `PlayerState.landSpeed?`; `PlayerInput.speedFactor?`; `GameContext` lists the v0.8 / v0.9 members main hands to
diagnostics (`physics?, zombies?, watcher?, survival?, pack?, setMode?, getMode?, urlMode?, selectSlot?, interact?, digTargeted?,
useSelected?`, §49). (worldgen.js types its generator locally as `SurvivalWorldGen`.)

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

v0.9 Survival (§47): blocks 76–94 (COPPER_ORE … FIRE_PIT, **`BLOCK_COUNT = 95`**), tiles 77–104 (`TILE_IDS` 115 entries; 250–252 are the
Watcher's, 240–245 the zombie's), `PICKER_ORDER` 80 entries, `PLANT_IDS`, `POP_OFF_IDS` and `isPlant, isLitter, isPopOff, isStation,
isContainerBlock`. Plants, litter, REMAINS and FIRE_PIT are cutout, walk-through, not replaceable and not fall-through.

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
  coalesce = false;           // … and only through 'coalesce' writes (World §9.2): waits LAZY_COALESCE_UPDATES calls between meshes
  meshedAt = -Infinity;       // World.update call count of its last mesh
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

v0.9 (§47): `createWorldGen(seed, { gen = 1 })`. Generation 1 (the default) is byte-identical to the above; generation 2 appends
`ORE_TABLE_GEN2` (copper, tin, clay), hex ponds, tree species (`treeTrunkAt`) and the `FLORA_TABLE` surface pass, and the generator
exposes `gen, pondAt, treeTrunkAt, FLORA_TABLE`. A warm generation-2 chunk is also held to ≤ 8 ms.

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
                             // origin), editVersion++, and marks dirty (lazily when `lazy` — true or 'coalesce', §9.2) every
                             // LOADED chunk containing the cell or one of its 6 HEX_DIRS neighbours (dedupes to 1–4 chunks; 4 only
                             // for the index-space corner cells lq=15,lr=0 and lq=0,lr=15).
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
  // v0.9 (§47): constructor opts.gen (normalised: an integer ≥ 1, clamped to GEN_LATEST; with an injected worldGen,
  //   opts.gen ?? worldGen.gen ?? 1) → `gen`; columnAt(q, r) → { height, biome, temperature } (a fresh object from the generator);
  //   findSurvivalSpawn() → Vec3 (findSpawn's spiral, PLAINS / FOREST at height ≥ SEA_LEVEL + 2 only, else findSpawn(); cached; copies)
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
   A lazy chunk with `coalesce` is left out (still pending) while `calls − meshedAt < LAZY_COALESCE_UPDATES`, where `calls` counts
   update() calls (this one included) and `_mesh` sets `meshedAt = calls` (every mesh, any step).
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
3. Lazy marks: for each loaded chunk to dirty, a non-lazy write sets `dirty = true, lazy = false, coalesce = false`; a lazy write
   (`lazy` true or 'coalesce') sets `dirty = true, lazy = true, coalesce = (lazy === 'coalesce')` only when the chunk was clean
   (non-lazy wins), and a `lazy = true` write to a dirty chunk sets `coalesce = false` (a plain lazy write never waits). Meshing
   clears all three. Block physics, black-hole eats and explosions write lazily; the player, commands and runes do not.
   'coalesce' (physics' `coalesceMesh`, §33.3): a big crumble's instant part (§36.3.1), whose chunks were re-meshed once per
   physics tick for seconds (an 8 000-cell box: world.update 125–139 → 720–853 ms in game, frame p50 4.5 → 12–14 ms; now
   271–433 ms and 5.6–7.7 ms, §38.4.4); with nothing animated standing in for those cells, a chunk may show them up to
   LAZY_COALESCE_UPDATES frames (⅓ s at 60 fps) late instead.
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
v0.9 (§45): `stepPlayer` zeroes `p.landSpeed` on entry (after its dt guard: a dt ≤ 0 / NaN step changes nothing) and, in every mode,
records `landSpeed = max(landSpeed, −vy)` whenever a substep's downward move hits a floor, before vy is zeroed (standing records one
substep of gravity). **Consume semantics:** `survival.step` reads it and sets it to 0; main zeroes it whenever it sets fallGrace.
`input.speedFactor` (clamped 0..1, absent 1) multiplies the horizontal target speed after the sneak / sprint / water choice, never in
flight. `bodies.standOn` records `landSpeed` on the rider it stops.
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
   inWater: if jump: vy = (hitWall && !input.noExitJump) ? SWIM_EXIT_JUMP : SWIM_UP_SPEED;  else vy = max(vy + WATER_GRAVITY*h, WATER_MAX_SINK)
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
export function isDayTime(time)           // SkyState.isDay without the sky: 0.25 <= wrapped t < 0.75 (zombies, §39)
/** SkyState = { time, isDay (0.25 <= t < 0.75), sunDir (toward sun by day, toward moon = -sun by night), sunColor, sunIntensity,
 *   hemiIntensity (= amb), zenithColor, horizonColor, fogColor, daylight (0..1), stars (0..1) } */
```
Keyframe values: use the table in `docs/SPEC-gameplay.md` §6 verbatim (`sun` → `sunIntensity`, `amb` → `hemiIntensity`).
Invariants: intensities ≥ 0; every colour channel in [0,1]; `computeSky(0)` equals `computeSky(1)`; continuous in `t`.

## 14. `src/storage.js`

```js
export const SAVE_KEY = 'caelancraft:v2:save';      // the ONE save of the versions before save slots (= LEGACY_SAVE_KEY, §41.3)
export const SAVE_VERSION = 2;                      // v2: edits are keyed by hex (q, r) chunks; v1 cube saves are not loadable
export function serializeSave(data)                 // SaveData → JSON string (keys in stable order)
export function deserializeSave(text)               // string → SaveData|null (null on parse error, wrong version, missing/invalid fields)
export function saveGame(data, storage = globalThis.localStorage)   // boolean; false when storage missing or setItem throws
export function loadGame(storage = globalThis.localStorage)         // SaveData|null
export function hasSave(storage = globalThis.localStorage)          // boolean
export function clearSave(storage = globalThis.localStorage)        // void
//   saveGame / loadGame / hasSave / clearSave work on SAVE_KEY only and are kept for tests and old data: main saves through the
//   slot API (§41: listSlots, loadSlot, saveSlot, deleteSlot, renameSlot, duplicateSlot, migrateLegacySave, storageUsage).
/** SaveData = { version: 2, seed: number, time: number, day: number, player: {x,y,z (WORLD),yaw,pitch,flying}, hotbar: number[9],
 *   selected: number, edits: EditsJSON, runes?: RunesJSON, pigs?: PigJSON[], physics?: PhysicsSwitches, zombies?: boolean,
 *   watcher?: boolean, watcherNight?: number, meta?: { name?: string, createdAt?: number, lastPlayed?: number } }
 *   EditsJSON = { "cq,cr": [localIndex, id, localIndex, id, ...] } */
```
**v0.9 Survival (§42).** `serializeSave` writes, after `watcherNight` and before `meta`, in this order: `gen` (an integer ≥ 2 only),
`mode` (`'creative' | 'survival'`), `survival` (an object, canonicalised by `normalizeSurvivalJSON`: `{ health, satiation, hydration,
temp, breath, wet, sick, heal, healRate, spawn: [q,y,r]|null, deaths, dead?, pack: (ItemStack|null)[27], wear: (ItemStack|null)[3],
fires: { "q,y,r": { s: ({k, t}|null)[7], f? } } }`, numbers to 3 dp) and `containers` (only when non-empty after
`normalizeContainersJSON`: `{ "q,y,r": { kind: 'basket'|'remains', slots } }`). **`version: 3` exactly when `gen ≥ 2` or `survival`
is present, else 2**; `deserializeSave` reads 2 and 3; `gen > GEN_LATEST` is unloadable (`unloadableReason`: "gen 3: made by a newer
version of Caelancraft"). `serializeSave` throws a TypeError for `gen > GEN_LATEST` or a non-object `survival` / `containers` (never
writes what loading would reject). Every other repair is a warning, never a null save: a bad `gen` (treated as 1), a bad `mode`
(Creative), a non-object `survival`, a bad stat (its fresh value), a bad pack / wear stack (null, with its reason), a wrong pack
length, fire entries (malformed key, more than MAX_FIRE_SLOTS, not 7 spots, bad fuel, **a cell that is not CAMPFIRE or FIRE_PIT in the
repaired edits**; a spot is emptied when its item cannot be on that kind of spot — the transform chain, §46 — or its `t` is bad),
containers (malformed key, unknown kind, too many slots, a cell not recorded in the repaired edits as its block; bad stacks become
null; not capped by MAX_CONTAINERS — deaths bypass it). A `mode: 'survival'` save below generation 2 loads in Creative with the §42
warning. Exports `SURVIVAL_SAVE_VERSION, SAVE_MODES, DEATH_CAUSES, SURVIVAL_STATS, normalizeSurvivalJSON, normalizeContainersJSON,
isSurvivalSave, unloadableReason`. A Creative world that never entered Survival writes none of the four and serialises
byte-identically to before (tested). Rename / duplicate / migrate keep all four; the slot index records `mode: 'survival'` for a
Survival world (`isSurvivalSave`: mode survival and gen ≥ 2) from both entry paths, and `SlotInfo.mode` lets the Worlds panel say
"· Survival".
`meta` (§41) is OPTIONAL: the world's name and times, so a slot's document alone says what the Worlds screen lists.
`serializeSave` writes it LAST whenever `data.meta != null` (a non-object throws a TypeError), canonicalised by
`normalizeWorldMeta(raw)`: `{ name?, createdAt?, lastPlayed? }` in this order, `name` through `cleanWorldName` (control characters
→ spaces, trimmed, cut to MAX_WORLD_NAME_CHARS code points, trimmed again; '' = unusable), times as integer ms ≥ 0; unusable fields
are left out and an empty result omits `meta`, so documents without it serialise byte-identically to before. `deserializeSave`
keeps what normalizeWorldMeta keeps, warning `meta.name: not a usable name, ignored` / `meta.<createdAt|lastPlayed>: not a timestamp,
ignored`; a non-object is dropped with `meta: not an object, ignored`. Exports `cleanWorldName, defaultWorldName, normalizeWorldName,
normalizeWorldMeta`.
`physics` (v0.8) is OPTIONAL: `{ falling, water, collapse, explosions }` booleans. `serializeSave` writes it whenever
`data.physics != null`, canonicalised by `normalizePhysicsSwitches(raw)` (exactly these four keys in this order; anything not
`=== false` is on). `deserializeSave` keeps it when it is a plain object (non-boolean switches warn `physics.<name>: not a boolean,
treated as on`); a non-object is dropped with the warning `physics: not an object, ignored`. **Absent means the world was saved
before v0.8**: main then starts it with collapse OFF (§33.8). Exports `PHYSICS_SWITCH_NAMES`, `DEFAULT_PHYSICS_SWITCHES`.
`zombies` (§39) is OPTIONAL: the world's zombies switch. `serializeSave` writes it whenever `data.zombies != null` (anything not
`=== false` is `true`); `deserializeSave` keeps a boolean and drops anything else with the warning `zombies: not a boolean, treated
as on`. Absent means on (new worlds and saves from before zombies). Zombies themselves are never saved.
`watcher` (§40) is OPTIONAL: the world's Hollow Watcher switch, by exactly the same rules as `zombies` (written whenever
`data.watcher != null`, anything not `=== false` is `true`; a non-boolean is dropped with the warning `watcher: not a boolean,
treated as on`; absent — new worlds and older saves — means on). The Watcher itself is a sighting and is never saved.
`watcherNight` (§40.1) is OPTIONAL: the night (`watcher.nightKey(time, day)`) of the world's last natural Watcher sighting, so a reload
in the same night cannot bring a second one. `serializeSave` writes it (after `watcher`, before `meta`) only when it is a whole number
≥ 0 (`Number.isSafeInteger`); anything else, null included, is left out, so documents without it serialise byte-identically to
before. `deserializeSave` keeps such a number and drops anything else with the warning `watcherNight: not a night number, ignored`
(never a null save); absent — no sighting yet, or a save from before the field — means none. It goes through renameSlot /
duplicateSlot / migrateLegacySave unchanged (§41: they re-serialise the parsed document). With `!==` against the current night key
(§40.1), even a corrupt in-range value can only ever block that one night.
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
§40 recipes 250–252 (`watcher_stone`, `watcher_cracks` — the stone's glow mask, read one tile right of it — and `watcher_smoke`)
are the Hollow Watcher's (tiles.js comments are normative). v0.4 recipes 28–71 live in tiles.js (its comments are normative): spruce/birch reuse the oak plank, bark, log-end and leaves layouts
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
v0.9 (§48): `setDigProgress(hit | null, p)` — the honey dig trace (`digTraceVertexCount`, `digTracePositions`,
`DIG_TRACE_CORNER_ORDER`).

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
 *  setHurtFlash(level),                    // §39: red screen-edge vignette #hurt-overlay (created in #hud when index.html has none),
 *                                          //   opacity = level 0..1 in 1/32 steps, hidden at 0; DOM touched only on change
 *  onSlotClick: (slot) => {},              // assignable; fired when a hotbar slot is clicked (only while picker open)
 *  dispose() } */
```
v0.9 (§48): `setSurvivalVisible, setVitals, setHotbarStacks, setActionProgress, setJobChip, addPickup` and the pure `vitalsKey`, …;
elements `#vitals-left`, `#vitals-right`, `#status-chips`, `#job-chip`, `#action-ring`, `#pickup-layer`, `#pack-glyph`. `setHotbar`
while the survival hotbar is shown only remembers the ids (Creative's hotbar comes back from them).

## 20. `src/menus.js` (DOM)

```js
export const SPLASHES = [ /* 18 strings from SPEC-gameplay §5.4 */ ];
export function createMenus(doc, atlasCanvas, callbacks)
/** callbacks = { onPlayWorld(slot), onNewWorld(slot, name, seedText), onRenameWorld(slot, name), onDuplicateWorld(slot), onDeleteWorld(slot) (§41: the
 *              Worlds panel; name / seed text untrimmed, main normalises), onResume(), onSave(), onStopRunes(), onQuit(), onClickToPlay(),
 *              onPickBlock(blockId, slot|null), onPickerClose(),
 *              onPhysicsToggle(name) (v0.8: 'falling'|'water'|'collapse'|'explosions'), onUndoPhysics() (v0.8), onZombiesToggle() (§39) }
 *  (#btn-stop-runes "Stop All Rune Scripts" in the pause menu fires onStopRunes; CONTROLS_SHEET lists T, /, R and Shift+R)
 *  Menus = {
 *   showTitle(slots, opts?), hideTitle(),   // sets a random splash, dirt background (makeTiledBackgroundDataURL DIRT), draws the logo, renders the controls sheet,
 *                                           //   closes any open form / dialog and shows the Worlds panel (setWorlds); hideTitle also blurs a focused control in it
 *   setWorlds(slots, opts?),                // §41: re-render the Worlds panel only; slots = storage.listSlots(), opts = WorldsOptions { now, usage
 *                                           //   (storage.storageUsage), readOnly (?nosave), defaultSeed (?seed), message, isError, focusSlot }
 *   showWorldsMessage(text, isError?), isConfirmOpen(),
 *   showLoading(done, total), hideLoading(),
 *   showClickToPlay(), hideClickToPlay(),
 *   showPause(seed, physics?, worldName?), hidePause(),   // v0.8 physics = PhysicsMenuState { switches, canUndo, undoKind? } refreshes the row first;
 *                                           //   §41 worldName → #pause-world under the title (hidden when empty); resets setQuitUnsaved(false)
 *   setQuitUnsaved(on),                     // §41: #btn-quit QUIT_LABEL "Save & Quit", or QUIT_UNSAVED_LABEL "Quit Without Saving" + class `danger`
 *   setPhysicsState(physics),               // v0.8: the Physics row (#btn-phys-falling|water|collapse|explosions: "<Label>: ON|OFF", class
 *                                           //   `off`, aria-pressed) and #btn-undo-physics (undoButtonLabel(canUndo, kind); disabled when !canUndo)
 *   setZombiesState(on),                    // §39: #btn-zombies "Zombies: ON|OFF" (class `off`, aria-pressed) in #pause-creatures
 *   showPicker(hotbar, selected), hidePicker(), isPickerOpen(),   // scrollable grid of PICKER_ORDER icons (64px canvases shown at 52px); click → onPickBlock(id, null); Digit1-9 while hovering → onPickBlock(id, slot)
 *                                           // styles.css: .picker-panel is a border-box flex column with max-height max(180px, calc(100vh − 8vh − 72px))
 *                                           //   and overflow-y auto; only #picker-grid (min-height 64px = one row, flex 0 1 auto, max-height 420px)
 *                                           //   shrinks and scrolls. At viewport heights ≥ 274px the panel ends above the hotbar (bottom 60px), which
 *                                           //   stays visible and clickable. Below that the panel stays 180px (chrome with a two-line hint, 116px, plus
 *                                           //   one row) so a block can always be picked, and only then overlaps the hotbar; if the hint wraps further
 *                                           //   (very narrow too), the panel scrolls
 *   getSeedInput(),                         // the open New World form's seed text ('' when no form is open)
 *   dispose() } */
```
New World is offered on empty slots only, so it never overwrites a world and asks nothing; Delete always goes through the in-game
`#confirm-dialog` (§41.4) — the game uses no `window.confirm`. Pure exports for the panel's text (tested): `formatBytes, formatLastPlayed,
slotDetailText, usageLabel, usageLevel, deleteConfirmText, latestSlot` (§41.4).
v0.8 pause menu (index.html, below "Stop All Rune Scripts"): `#pause-physics.physics-row` = label "Physics" + four `.mc-button.toggle`
buttons, then `#btn-undo-physics`. CONTROLS_SHEET row R: "Run a Rune Block · light a Blast Barrel".
v0.9 (§48): callbacks `onNewWorld(slot, name, seedText, { survivalResources })`, `onModeSelect(mode)`, `onWake()`, `onDeathQuit()`
(and §14's `onGuide()`); Menus adds `setModeState, getModeState, confirm(opts) → Promise<boolean>, showDeath, hideDeath, isDeathOpen`;
`PhysicsMenuState.survival` disables Undo ("Undo (not in Survival)"); the Worlds rows show "· Survival"; CONTROLS_SHEET keeps 17 rows
(LMB `Break block (hold) · Survival: hold to dig`, RMB `Place block · Survival: use the item in hand`, E `Blocks · Survival: pack &
making`, R `Use: rune, barrel, fire, water, plants, basket`, Space Space `Double-tap: fly (or F) · Creative`).

## 21. `src/audio.js` (WebAudio, optional feel)

```js
export function createAudio()   // → Audio; everything is a no-op when AudioContext is unavailable
/** Audio = { resume() (call on first user gesture), playBreak(soundGroup), playPlace(soundGroup), playClick(), setMuted(b), toggleMuted() → boolean, get muted,
 *   playOink(v), playSqueal(v), playCrackle(v), playThud(v) (v0.8: sine 110 → 45 Hz 160 ms + 500 Hz noise knock),
 *   playSplash(v) (v0.8: 0.35 s 1.6 kHz noise wash + two rising blips),
 *   playBoom(v) (v0.8 §37: sine thump 72 → 26 Hz 1.1 s + 0.9 s 420 Hz noise body + slowed 150 Hz rumble from +0.12 s + 60 ms 3.2 kHz crack),
 *   playHiss(v) (0.3 s 7 kHz noise breath), playFizzle(v) (0.45 s 2.5 kHz noise wash over a sine sagging 700 → 180 Hz),
 *   playCreak(v) (§36, below),
 *   playGroan(v) (§39: a 1 s sawtooth moan 92 → 118 → 70 Hz through a 520 Hz lowpass, a detuned fifth above it, a breathy noise),
 *   playZombieHurt(v) (0.22 s 170 → 230 → 110 Hz bark over a 50 ms noise slap),
 *   playZombieDown(v) (0.8 s moan sinking 130 → 40 Hz, a 300 Hz noise poof, a 90 → 40 Hz thump),
 *   playWatcherVanish(v) (§40: faint and low — two sines 68 → 30 and 71.5 → 31.5 Hz over 1.6 s beating against each other,
 *     a 1.3 s 240 Hz noise breath and a 0.25 s 900 Hz air rush; peak gain WATCHER_VANISH_GAIN 0.2) }
 *   — volume v in 0..1, every sound scales linearly with it. main calls the physics sounds (§33.7) through PhysicsHooks.sound. */
```
Synthesis per SPEC-gameplay §9.
v0.8 trees: `playCreak(v)` (a tree starts to topple, §36.5.3): a 0.6 s sawtooth 85 → 135 → 60 Hz through a 700 Hz lowpass plus a 0.25 s
1.2 kHz noise rasp. (The explosives branch also wrote a `playCreak`; the merge kept this one, §38.1.2.)
v0.9 (§48): `playHurt(v), playDeath(v?), playEat(v?), playDrink(v?), playDig(group, v), playCraft(v?), playToolBreak(v?),
playSizzle(v), playPick(v?)`.

## 22. `src/diagnostics.js` (DOM)

```js
export function parseParams(search = location.search)   // → Params { seed: string|null, rd: number|null (1..16), smoke, autoplay, nosave, debug, fly: boolean, time: number|null,
                                                         //            yaw: number|null (degrees), pitch: number|null (degrees, ±89.9), ui: 'console'|'editor'|null,
                                                         //            slot: number|null (§41: an integer 1..SAVE_SLOTS, anything else null — never clamped) }
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
v0.9 (§49): `Params.mode` (`readModeParam`), `ui: 'pack'`; the F3 `Survival:` line (`survivalDebugLine`); the debug handle's
`survival`, `pack` and survival helpers; GameContext's survival members and the states `'pack' | 'book' | 'dead'`; the smoke test's
switch to Creative and its optional survival step.

## 23. `src/main.js` (glue; owns the game loop)

Boot: `params = parseParams()`; unless `params.nosave`, `migrateLegacySave()` (§41.3; a status other than 'none' / 'migrated' is a
console warning); `currentSlot = params.slot ?? 1`; DOM handles; `atlasCanvas`, `atlasTexture`, `renderer`, `hud`, `menus`, `controls`, `audio`.
State machine: `title → loading → clickToPlay → playing ⇄ paused`, `playing ⇄ picker`, `playing ⇄ console`, `playing ⇄ editor`.
Console/editor are modal like the picker: `setState` BEFORE `controls.unlock()`, controls disabled, simulation frozen (the rune runner too),
rendering continues. Closing any modal goes through `enterPlayingFromModal()`: `enterPlaying()` then, if the pointer lock is not back after
`RELOCK_CHECK_MS` (Esc is not a user activation, so the request may be refused), the click-to-play overlay is shown instead of a dead playing state.
- **Title = the Worlds screen (§41)**: `menus.showTitle(listSlots(…, { repair: !nosave }), { now, usage: storageUsage(slots), readOnly: nosave,
  defaultSeed: params.seed, focusSlot })`. Play → `loadSlot(slot)` (null → status line "World N could not be loaded" and a re-list), then
  `currentSlot = slot`, the name / createdAt from `save.meta`, start with the save. New World (slot, name, seedText) → refused with a status line
  when the slot is no longer empty (not under nosave), else `currentSlot = slot`, `worldName = normalizeWorldName(name, slot)`, `worldCreatedAt =
  Date.now()`, seed from the text (`seedFromInput`: `normalizeSeed` on trimmed text; empty → random `Math.floor(Math.random()*2**31)`), start.
  Rename / Duplicate / Delete → `renameSlot` / `duplicateSlot` / `deleteSlot`, then `menus.setWorlds` with a status line (`worldsFailMessage` on
  failure) and that row focused; under nosave they only say "Saving is off (?nosave=1): worlds cannot be changed".
  `params.autoplay || params.smoke` → skip the title and play slot `currentSlot`: `save = nosave ? null : loadSlot(currentSlot)`; a DAMAGED slot sets
  `params.nosave` (warning: never overwritten from a URL); then `params.seed ?? save?.seed ?? random` exactly as before (a different ?seed than the
  slot's save sets nosave), the name from the save's meta (else "World N").
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
  `visibilitychange(hidden)`, pause, Save, Quit. Skipped when `params.nosave`. `buildSaveData` includes `runes: runeStore.export()` and (§41)
  `meta: { name: worldName, createdAt: worldCreatedAt, lastPlayed: Date.now() }`. Every save goes to `saveSlot(currentSlot, data)` — the current
  slot only; a failure shows the red toast `saveFailMessage(reason)` ('quota' → "Save failed: storage full — delete a world on the Worlds screen
  to make room") and the slot keeps its previous save. `finishLoading` saves a NEW world at once (it claims its slot; a no-op under nosave).
  The pause menu shows `menus.showPause(seed, physics, worldName)` (+ " · not saving" under nosave); "Save & Quit" (`#btn-quit`) saves and returns
  to the Worlds screen with that world's row focused. A Save & Quit whose save FAILS does not quit: the red toast explains, the world stays
  open and the button turns into "Quit Without Saving" (`menus.setQuitUnsaved(true)`, reset by the next pause); pressing it saves once more
  and, failing again, quits with the Worlds status line `“<name>” was not saved (storage full) — its last save is kept. Delete a world to
  make room.` (the world is never closed without the player choosing to lose the unsaved part).
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
- **Zombies (§39.3)**: `stepZombies` runs right after `stepPigs` (so the order is player → black holes → pigs → zombies →
  blockPhysics → campfires → resolveBodies); zombies join `resolveBodies` and PhysicsHooks.bodies; `renderFrame` calls
  `zombieRenderer.sync(zombies.list)` and fades the HUD hurt flash.
- **The Hollow Watcher (§40.4)**: `stepWatcher` runs right after `stepZombies` (… → zombies → watcher → blockPhysics → …); it is not
  a body. `renderFrame` calls `watcherRenderer.sync(watcher.figure, player.x, eyeY, player.z, fxTime)`.
- Diagnostics: `installErrorCapture` → `hud.showError`; `installDebugHandle`; if `params.smoke` → `runSmokeTest(game)` once playing.
- `window.resize` → `renderer.resize(innerWidth, innerHeight)`.
- **Survival (v0.9)**: states `pack`, `book`, `dead`; the frame order with its death checkpoints, the queued mode switch, the second
  `waterHit` ray, hold-to-dig, the R priorities, RMB use, the pack screen, lanes, fire spots and fuel, damage, death and waking,
  saving and loading: **§49**. Creative's code paths are unchanged.

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
runner: RuneRunner, rune: Rune|null, running: Running|null, seed, physics?: BlockPhysics (v0.8), pigs?: Pigs, zombies?: Zombies (§39),
watcher?: Watcher, watcherWorld?: WatcherWorld (§40; main's getter refreshes the view first) }`. The runner sets `rune`/`running` around each script command; the
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
| `summon zombie [q y r]` | §39, needs `ctx.zombies` (`zombies are not available here`); refuses while switched off (`zombies are off in this world (zombies on to allow them)`), at ZOMBIE_MAX, unloaded targets, 2–3 args; like `summon pig` with the zombie's size, facing the player; works by day too (it then burns under open sky) |
| `zombies [clear\|on\|off]` | §39: `N zombies (max 16) · zombies are on\|off in this world`; `clear` → `removed N zombies`; `on`/`off` → `setEnabled` → `zombies on (saved with this world)` / `zombies off (saved with this world)[: removed N zombies]` / `zombies are already on\|off` |
| `summon watcher [q y r]` | §40, needs `ctx.watcher` and `ctx.watcherWorld` (`the Watcher is not available here`); refuses while switched off (`the Watcher is off in this world (watcher on to allow it)`), while one is present (`the Watcher is already here`), 2–3 args. Alone: `watcher.summon(watcherWorld)` — far away in view at any time of day; none found → `no open ground for it out there in view (try another direction, or a render distance of 4 or more)`. With a cell: y in `0..WORLD_HEIGHT−3`, loaded (`target is not loaded`), feet at `findFreeY(y, 2, radius 0.2, WATCHER_HEIGHT)` (`target is inside a block`) → `summonAt`. Ok: `summoned the Watcher at q y r, N away` |
| `watcher [on\|off]` | §40: `the Watcher is on\|off in this world · it is here, N away` / `· it is not here`; `on`/`off` → `setEnabled` → `the Watcher on (saved with this world)` / `the Watcher off (saved with this world)[: it is gone]` / `the Watcher is already on\|off` |
| `physics status\|on\|off` | v0.8, needs `ctx.physics`: `status` → `physics.statusText()`; `off` / `on` → `setPaused` ("block physics paused: nothing falls, flows or explodes until physics on (not saved)" / "block physics running"); a lone feature name reports `<f> is on\|off` |
| `physics <falling\|water\|collapse\|explosions> on\|off` | `setSwitch` → `<f> on\|off (saved with this world)` or `(already)`; an unknown feature fails |
| `undo` | `physics.undo()`: its message (ok) or failure (`nothing to undo …`, `… too late to undo`); in Survival `not in Survival` (§33.8) |
| `ignite q y r` | y in range and the cell loaded, then `physics.explosions.ignite(q, y, r)` → its `{ ok, message }` |
| `drain [radius]` | radius `0..DRAIN_MAX_RADIUS` (default DRAIN_DEFAULT_RADIUS) around the rune's cell in scripts, the player's cell (`worldToHex`, `floor(y)`) in the console → `physics.fluids.drain(q, y, r, radius)` |
All four fail with `block physics is not available here` when the context has no `physics`.
**v0.9 Survival** (through the optional `ctx.survival`, §49): `mode [creative|survival]` — the new flag **`consoleOnly: true`**
(only `mode` has it; no command is both scriptOnly and consoleOnly): `executeCommand` fails `mode is only valid in the console` while
`ctx.running` (a rune's step-on script could otherwise reload the world under the runner); no args → `mode: creative` / `mode: survival
(Health 87 · Nourishment 64 · Hydration 51 · 36.9 °C)`; with one → `ctx.survival.setMode(m)` (queued) and its message. `vitals
[full|health|nourishment|hydration|temp|breath] [value]` (prints stats and labels, or sets one, clamped; `~` relative; `full`
restores all; without a state `no survival state in this world (try mode survival)`). `pack [list|add|clear] [item] [count]` (`add`
through `resolveItem`, counts 1–9999, `added 12 Rock` / `… (3 did not fit)`; a `packAdd` result with `refused` fails with that text —
main's `consolePackAdd` (§49) refuses a second Handbook: `the pack already has a handbook`, `one handbook is enough` for a count above
1; `clear` empties the pack and the worn items and then the Handbook comes back, `consolePackClear`). `items [filter]` (8 keys a
line). In Survival `fly` and `undo` fail `not in Survival` and `give` fails `in Survival use: pack add <item> [count]`.
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
Pigs never die **in Creative**; in Survival see §45 (`health`, `wound`, `pruneFar`, `spawnNatural(…, surfaces)`) and §49 (hunting
and repopulation). Constants `PIG_*` live in config.js.
```js
export function seededRng(seed)                // mulberry32
export function validatePigsJSON(raw)          // → { pigs: [{x,y,z,yaw}], warnings }: finite numbers, y ≥ −16 (above
                                               //   WORLD_HEIGHT is clamped to it, not dropped), ≤ PIG_MAX kept
export const PIG_HEAD_BOX                      // { x: 0.22, y0: 0.49, y1: 1.0, z0: −0.78, z1: −0.33 }: the drawn head, snout
                                               //   and ears in pig space (facing −Z, feet at y 0), outside the cylinder
export function rayHeadBox(pig, ox, oy, oz, dx, dy, dz) → number   // entry distance into PIG_HEAD_BOX turned by pig.yaw
                                               //   (0 inside, Infinity on a miss)
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
  raycast(ox, oy, oz, dx, dy, dz, maxDist) → { pig, distance }|null   // the nearer of the body cylinder PIG_RADIUS ×
                                               //   PIG_HEIGHT at the feet and PIG_HEAD_BOX (rayHeadBox)
  export() → PigJSON[] (mm-rounded; y clamped to ≤ WORLD_HEIGHT) ; load(validatedList)
  spawnNatural(count, q0, r0, seed, getBlock, isLoadedCell, minDist = 4, maxDist = 18) → placed   // grass surfaces only, seeded
}
// Shared with zombies (§39): fireAhead(getBlock, x, z, yaw, fy) (AI step 3's fire look-ahead; Pigs._fireAhead delegates),
// shoreYaw(getBlock, x, y, z) → yaw|null (the bank search of step 1; Pigs._shoreYaw delegates), isOpen(id), wrapAngle(a).
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
a pig in water always paddles up (it floats; pressing into a bank gives SWIM_EXIT_JUMP — unless `!canHop`: `input.noExitJump`, so
a pig carrying or riding another cannot launch it over a pool's rim, play-test PB-1), and on land it hops only a one-cell
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
   `prewarm(webglRenderer, camera)` (main calls it while the game loads, once every renderer that adds a light — this one and the falling
   renderer's explosion flash — exists, since the PointLight count is part of every program's key) compiles every campfire
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
**v0.9 Survival (§46):** every campfire has seven fire spots (six skewers, the embers), drawn by `campfireRenderer.sync(…, spotsView)`
(§48); fires **placed in Survival** need fuel and burn out into the meshed FIRE_PIT block (which campfires.js never tracks: no heat,
light, smoke or safe zone), relit with a fire drill. Fires placed in Creative or saved before v0.9 have no fuel entry and burn forever
as above. A scorch in Survival also deals FIRE_BURN_DAMAGE (§45).

## 33. `src/blockphysics.js` (PURE) — the block-physics scheduler, v0.8

One `BlockPhysics` per World. It owns the feature modules and every queue; features plug in through the registry and never
edit this file. Rationale and measurements: `docs/DESIGN-physics.md` §2; the plug-in reference is its §10.
```js
export const RINGS = ['fall', 'water', 'misc'], RING_DELAY = [1, WATER_TICKS, 1]       // ticks from schedule() to update
export const FEATURES = ['falling', 'water', 'collapse', 'explosions']
export const WRITE_EXTERNAL = 0, WRITE_PHYSICS = 1, WRITE_QUIET = 2                      // the `mode` triggers receive
export const CAUSE_WORLD = { kind: 'world' }, CAUSE_PHYSICS = { kind: 'physics' }, CAUSE_AREA = { kind: 'area' }
export class SeedQueue        // support seeds: priority lane + normal lane, cell-level dedupe; size, push(seed), shift(), peek(), clear(),
                              //   list() → the pending seeds in shift() order, none removed
export class SaveOverlay      // copy-on-write save view (world, { keepFlow }): peek(q,y,r), set(q,y,r,id), toJSON() → EditsJSON (§33.9)
export class BlockPhysics {
  constructor(world, hooks = {}, { now }?)   // hooks: PhysicsHooks (§33.7), missing ones are no-ops; now: ms clock (default world._now)
  world; hooks; ctx (RuleContext, §33.3); fallers; fluids; support; trees; explosions   // the feature modules (§34–§37)
  switches { falling, water, collapse, explosions }; switchVersion; paused; tickCount; time; stats; seeds (SeedQueue); lastEvent
  coalesceMesh = false      // set by support around a crumble's instant part: writes reach setBlock as lazy 'coalesce' (§33.3)
  registerRule(name, { ring | rings, feature?, ids?, update(ctx, q, y, r, id) }); unregisterRule(name); ruleNames(ring)
  addTrigger(name, feature, fn(q, y, r, prev, next, mode)); removeTrigger(name)
  addReseeder(name, feature, ids, fn(ctx, q, y, r, id)); removeReseeder(name)
  schedule(ring, q, y, r, delay?) → boolean; queued(ring?) → n; isQueued(ring, q, y, r); get parkedCount
  isEnabled(feature); setSwitch(name, on) → changed; setPaused(on); exportSwitches(); importSwitches(raw)
  onBlockChange(q, y, r, prev, next); onChunkGenerated(cq, cr)          // main forwards World's hooks
  seedSupport(cells, { priority?, cause?, removed? }) → queued; seedRemoval(q, y, r, prev, opts?); collectAreaSeed(q, y, r, prev);
  flushAreaSeeds(); get areaSeedCount; seedRemovals(cells: [q, y, r, prev][], opts?) → queued   // ONE seed for a gravity column
  pendingSupportSeeds() → SupportSeed[]   // seeds.list() plus the unflushed area removals as their seed; nothing is taken
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
the triggers (`write` → WRITE_PHYSICS, `writeQuiet` → WRITE_QUIET) and, when an event is open (§33.8), recorded into it. While
`coalesceMesh` is set the write is `world.setBlock(q, y, r, id, 'coalesce')` instead (World §9.2: its chunks re-mesh in coalesced
steps; §36.3.1).
### 33.4 Parking and re-seeding
1. `ctx.park()` parks the CURRENT update on the chunk of the last UNLOADED cell `ctx.peek` returned (or of column (q, r) when given):
   it leaves the ring and waits in `parked[chunkKey]` (a Set of `ringIndex·2^50 + key`), at most MAX_PARKED_UPDATES in total
   (beyond: dropped and counted in `parkedDropped` — re-seeding covers them).
2. `onChunkGenerated(cq, cr)` re-queues every update parked on that chunk (due next tick), calls `support.onChunkGenerated(cq, cr)`
   while collapse is on (the collapse cells parked on it, §36.3.5), then hands every EDITED cell of the chunk whose id a reseeder
   lists to `fn(ctx, q, y, r, id)` (reseeders of switched-off features are skipped).
3. Built-in reseeders: 'gravity' (falling): SAND/RED_SAND/GRAVEL/CAMPFIRE over a fall-through cell → `fall`, and every edited
   fall-through cell (AIR, CAMPFIRE, any water) whose origin is NOT fall-through (`!isFallThrough(world.originAt(…))`: it was dug out —
   exactly when the live 'gravity' trigger fired, §33.5.2) with a gravity block or a campfire above it → that cell into `fall` (the rings
   are not saved: natural sand dug out from under just before a save — always so under `physics off` — falls after the reload). A cell
   generated fall-through (cave air, the sea) that only changed to another fall-through id — a source or campfire put under natural sand
   — queues nothing: live play never moved that sand, so a reload or stream-in does not either (*re-queuing above ANY edited fall-through
   cell dropped worldgen's natural sand on cave air onto the player's water or campfire on reload and stream-in only*). The save cannot
   tell more: a cell back at its generated id carries no edit, so a fall still queued over a cave cell filled and dug out again right
   before a save is lost; 'water' (water):
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
   (queued updates are skipped when popped) — switching it on again never acts on what happened meanwhile, with ONE exception:
   switching **falling** back on runs the 'falling' reseeders over every loaded chunk's edits (`_reseedChunk(cq, cr, 'falling')`,
   the pass a chunk gets when it generates), so sand left hanging while it was off falls at once — live play then matches what a
   stream-in or reload would do (play-test G4). `importSwitches(raw)`:
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
   **v0.9: Undo is disabled in Survival** (SV): it restores every cell the event wrote, which would duplicate whatever the player mined
   from a toppled tree or a collapse. The pause menu shows `#btn-undo-physics` disabled as "Undo (not in Survival)" and main's
   `onUndoPhysics` refuses (§42, §49). The console `undo` fails `not in Survival` too (§26.4; it would duplicate mined debris just
   the same). A world switched back to Creative may undo again.
### 33.9 Saving (`exportEdits`, never touches the live world)
`overlay = new SaveOverlay(world, { keepFlow: !switches.water })`; `fallers.settleInto(overlay)`, `support.settleInto(overlay)` (what a collapse has not brought
down yet is saved fallen, §36.6.4), `trees.settleInto(overlay)`, `explosions.settleInto(overlay)`;
return `overlay.toJSON()`: world.edits overridden by the overlay's cells, where an edit of FLOW_1..6 / FALL is DROPPED when its origin
is AIR or WATER (the cell reloads as generated: a refilled hole in a lake is lake again) and saved as AIR otherwise (sources and
the AIR next to natural water re-flow through the 'water' reseeder on load, §35.3) — UNLESS `keepFlow` (water switched off):
then FLOW/FALL edits are saved as they stand, since nothing re-flows them on load while water is off; the reload shows the same
frozen flow as the live world (play-test G3). `overlay.peek` = overlay cell, else
`world.peekBlock`; `overlay.set` refuses y outside 0..127.
### 33.10 Rendering and status
`renderItems()` fills a pooled list `{ items, count }` (`RenderItem = { id, x, y, z, rx, ry, rz, scale }`, centre + Euler 'YXZ' +
uniform scale) from `fallers.renderItems(push)`, `trees.renderItems(push)`, `explosions.renderItems(push)` with
`push(id, x, y, z, rx = 0, ry = 0, rz = 0, scale = 1)`. `bodies(out)` appends `explosions.bodies(out)`. `status()` → `{ paused,
switches, queued: { fall, water, misc }, parked, seeds, fallers, tumblers, trees, litBarrels, edits, tick, lastTickMs,
lastTickUpdates, canUndo }`; `statusText()` is its one-line form (console `physics status`).

## 34. `src/fallingblocks.js` (PURE), `src/fallingRenderer.js` and `src/particles.js` (three) — falling blocks, v0.8

```js
export const GRAVITY_RULE_IDS        // [SAND, RED_SAND, GRAVEL, ...POP_OFF_IDS] (v0.9; POP_OFF_IDS begins with CAMPFIRE)
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
For a cell holding a gravity block or a campfire: below = `ctx.peek(q, y−1, r)`; UNLOADED → park; not fall-through, or a cell a lit
barrel entity rests in (`explosions.occupiesCell`, §37.4.5) → nothing. A
CAMPFIRE breaks: `ctx.write(AIR)`, 10 'smoke' particles at y + 0.3, sound 'break:wood'. A gravity block drops its whole column:
from y upward while the cells are gravity blocks (at most MAX_COLUMN_FALL), each is written AIR with `ctx.writeQuiet` (stop at the
first refused write) and becomes a faller at its own cell — so the column falls together, at one speed — and the column queues ONE
support seed with all its removals (`physics.seedRemovals`; cause = the current cause, priority for a player cause) instead of one
per cell (a cut 217-column sand tower used to queue thousands). When fewer than n slots are free, the LOWEST (n − free) settle
instantly (`settleNow`) and the rest animate. The scheduler reads its clock after such an update (≥ 32 writes, §33.1.4), so a tick
overruns its budget by at most about one column. Falling into a campfire or any water passes through it (v0.8 water,
§35.6: sand sinks through sources to the bottom; the landing cell's water is crushed).
**v0.9 pop-off blocks (§47):** every `isPopOff` id (CAMPFIRE, FIRE_PIT, the plants and the litter) behaves as the campfire does here:
the gravity rule, the blockphysics falling trigger and the gravity reseeder test `isPopOff(id)`, the cell is written AIR, and
`popOffEffect(id)` gives its puff and sound (a campfire keeps its smoke and 'break:wood'). Popped blocks drop nothing. The `ignite`
trigger stays CAMPFIRE only. A Survival placement of a pop-off block over a non-solid cell is refused (`needs solid ground`, §44).
### 34.2 Column fallers
1. Kept in typed arrays (id, q, r, y, vy, event) sorted by y (insertion sort per frame — or one index sort when more than 32 were
   spawned since the last sort: columns spawned bottom-up one after another made the insertion sort quadratic) and processed LOWEST
   FIRST, so a stack landing in one frame piles up exactly. Frozen while `!world.hasChunkAtCell(q, r)`.
2. Per frame: `vy = max(vy + GRAVITY·dt, TERMINAL_VELOCITY)`, `y1 = y0 + vy·dt`. If the cell containing the bottom
   (`c0 = floor(y0)`, when y0 is not an integer) is not fall-through, land at `c0 + 1`. Otherwise sweep `b = c0 − 1 … floor(y1)`
   (b ≥ 0) and land at `b + 1` on the first cell that is not fall-through. No landing and `y1 < 0` → removed. Else `y = y1`.
   Throughout §34 (this sweep, landing, `settleNow`, `settleInto`), a cell a lit barrel entity rests in
   (`explosions.occupiesCell`) counts as NOT fall-through: blocks pile on top of a burning barrel instead of landing in its cell,
   which used to pop the barrel up through the pile one cell per landing (play-test B3).
3. **Landing** in cell C (`_placeLanded`): if C is not fall-through, move up (≤ 4 cells) to the first fall-through cell, else break.
   For a solid id, every body in `hooks.bodies()` that `playerIntersectsBlock` C is lifted to `liftFreeY(world + C, body, 3)`: the
   first feet height floor(y)+1, +2, +3 (its own radius and height) that is free, reached STRAIGHT UP — at each height that is not
   free, the body's newly entered top layer (`ceil(h + height) − 1`) must be non-solid in every footprint column, else there is no
   lift (so a body under a 1- or 2-thick roof is never carried through it; a block that landed in the body's own cells is not in
   the way and the body pops on top of it, play-test SAND-1); if any body has no lift the block BREAKS (dust, nothing placed). Then `ctx.write(C, id)` inside
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
`prewarm(webglRenderer, camera)` (main calls it while loading, after every renderer that adds a light exists, like the campfires' §32.2) builds the meshes of
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
WATER_FLOW_1..6 (level k) and WATER_FALL (water with water above it that its sides do not feed better) are derived from their
neighbourhood, never placed by hand and never saved (§33.9). Wired elsewhere: the scheduler's 'water' trigger (§33.5), main's
WATER-selected ray, source removal and current pulls (§23), `drain` (§26), the surfaces in the mesher (§10.2) and physics (§12.1). A lit
barrel touching water is put out by explosions.js (§37), which reads `isWater` itself — fluids exports no hook for it.
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
non-FALL cell above: WATER → 7, FLOW_k → k, anything else → 0). A cell with water above whose sides feed it better than that is FLOW,
not FALL (§35.2 2b–c), so every water cell's E is the best of what falls into it and what its sides feed it, and **more water never
lowers a level**. *With E(FALL) = fallLevel alone, a FLOW_1 trickle dripping onto a FLOW_5 channel cell made it FALL (1) and dried the
whole stream downstream (review water-3 regression), and a reload's reflow — every source at once — ran a stream past such a cut
before its trickle arrived, putting out a campfire live play kept lit.* A water cell n **spreads** (feeds its six side neighbours) iff
the cell below n is a floor (`isWaterFloor`): solid or a WATER source — never over FALL, FLOW, AIR, a campfire or UNLOADED. *This one
predicate bounds waterfalls: falling water only spreads where it lands. And falling keeps a stream's level, it never refreshes it: with
E(FALL) = 7 every 1-high step of a hillside restarted a full reach-6 disc, and one source on seed 7's highest hilltop wet 9,999 cells down
to the sea (24,409 on a synthetic 40-step staircase); now every FLOW_k is within 7 − k cells of a source and the same source wets 150.*
### 35.2 The rule (`update(ctx, q, y, r, id)` on the `water` and `fall` rings)
Every input is read before anything is written. A side neighbour that is UNLOADED: when `id` is water, `ctx.schedule('water', that
cell)` (it parks on its own chunk), then `ctx.park(its q, r)` and return — both re-run when that chunk is generated. The target:
1. `id === WATER` → WATER.
2. Otherwise, with `sources` = the WATER side neighbours and `fed = max(E(n) − 1)` over the side neighbours n that spread:
   a. `id` is FLOW_k or FALL, and either `sources ≥ WATER_SOURCE_NEIGHBOURS` (3) with the cell below a floor (infinite source), or
      the cell was generated as WATER (`world.originAt(q, y, r) === WATER`: natural sea / lake water coming back — the save drops such
      an edit anyway, §33.9, so the live world and a reload agree) → **WATER**;
   b. else the cell above is water and `fed === 0 || fallLevel(ctx, q, y, r) ≥ fed` → FALL;
   c. else `fed ≥ 1` → FLOW_fed (also with water above: fed better from its sides than by the fall — a trickle landing in a stream
      keeps the stream's level);
   d. else AIR (a CAMPFIRE stays a CAMPFIRE).
3. `target !== id` → `ctx.write(target)`; when 'ok': a replaced CAMPFIRE → `ctx.sound('hiss', centre)` + 12 'steam' particles; an empty
   cell that became FALL over a floor, or FLOW_6 → `ctx.sound('splash', centre, 0.8 | 0.4)` (main throttles). Then return (also on
   'capped': physics holds water back). The trigger queues the cell below new water on the `fall` ring, so **a waterfall advances
   exactly one cell per tick**.
4. Unchanged, the target is WATER or FLOW_k, `y > 0` and the cell below is AIR, CAMPFIRE or FLOW_j with `j ≤ waterLevel(target)` (7 for
   WATER) → `ctx.write(below, FALL)` (a campfire there: hiss + steam). A higher FLOW below is fed better from its sides (2c): left alone.
Consequences (`tests/unit/fluids.test.js`): one source on flat ground → exactly 126 FLOW cells, level `7 − hex distance`; one source in
mid-air → a FALL column landing at full strength (E 7) and those 126 FLOW cells around where it lands; one source on a 10-high, radius-3
plateau → 367 water cells (240 falling: the FLOW_3 over the edge lands as 3 and spreads FLOW_2, FLOW_1), and none — with every edit pruned
— once the source is removed; down a staircase (or seed 7's hillside) every FLOW cell is `7 − its hex distance` from the source, within
reach 6; a FLOW_1 trickle falling into a one-wide FLOW channel leaves it `W 6 5 4 3 2 1` (the landing FLOW_5 under the fall, whichever
source came first), a source on the trickle's tip makes the landing FALL (7) and the channel past it 6 5 4 3 2 1, and taking either
source away leaves exactly the other's water; since more water never lowers a level, a reload's reflow only ever rises to the live state
(nothing it wets ends dry, no campfire goes out that live play keeps lit — trickle and stepped-terrain checks in `saving and
reloading`); two adjacent sources stay two sources (their two shared neighbours see only 2); three around a hole make 7 and stop; a hole
next to a straight sea edge fills (FLOW_6, over FALL when deeper); a drained patch of open sea refills to the generated sea and leaves
no edits — over a flat or an uneven seabed (before natural water healed by 2a, `drain 6` over seed 42's sloping seabed left 163 cells
AIR and 369 edits: the surface ring stood on FALL, the bottom ring touched sand instead of three sources).
### 35.3 Trigger and reseeder
1. **'water-floor'** (feature water): `isWaterFloor(prev) !== isWaterFloor(next)` and the cell above is water → wake each side neighbour of
   that water cell which is AIR, CAMPFIRE, FLOW, FALL or UNLOADED. Also: `prev !== next`, either is water and the cell below is FALL → walk
   down that FALL column (its `fallLevel` changed all the way down): wake each FALL of it that has a side neighbour that spreads (2b
   compares the fall with that feed); then, under its lowest FALL, wake a FLOW (fed better from its sides: it compares again), or — when
   that cell is a floor — wake the landing's side neighbours the same way. (*The scheduler's 'water' trigger covers the changed cell and
   its 8 neighbours; the rule also reads the cells below its side neighbours and the column above itself and a falling neighbour.*)
   **Wake** = `schedule('fall', …)` for FALL or a non-source cell with water above, else `schedule('water', …)`.
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
  get busy                           // a batch is open or a crumble comes down (§36.3.1)
  get crumbleCount; get parkedCount; tipSaid                                     // crumbles in progress; cells parked (§36.3.5)
  stats { batches, searches, visits, floating, crumbled, toppled, restarts, parked, parkedDropped, resumed, watched }
  step(ctx, seeds: SeedQueue, maxVisits) → visits; reset(); onSwitch(on)       // off → reset()
  cancelEvent(id) → 0; settleInto(overlay); onChunkGenerated(cq, cr)   // undo / saving / streaming (§36.3.2, §36.6.4, §36.3.5)
}
export const CRUMBLE_SLICE           // 64: a big crumble's cells between two deadline checks (§36.3.1)
export function peekNeighbours(world, q, y, r, out, chunk?) → out   // the 8 neighbour ids (6 sides, above, below) as peekBlock gives
                                     // them, read straight from the chunk when the cell is off its edges (one lookup, not eight);
                                     // a cell of an unloaded chunk reads its 6 sides one by one (they may be loaded)
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
  decayHangingLeaves(cells, { event?, naturalOnly? }?) → n   // after a crumble, a topple, a batch's log removals (§36.6.1)
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
   while a batch is open or a crumble comes down); a batch ends once its last component has begun to collapse (a crumble goes on
   by itself, §36.3.1), and when budget is left the next one starts. A 30 000-removal
   `fill … air` batch takes ~10 ticks of ≤ 3 ms instead of one 150–400 ms tick.
5. Trigger 'support' (collapse): while a batch is open, an EXTERNAL write (mode `WRITE_EXTERNAL`) that makes a cell load-bearing
   restarts the current DFS when the cell touches one of its pushed cells (`stats.restarts`), and marks a found component next to it
   stale (never collapsed). Physics' own writes are ignored there; removals need nothing (they seed the next batch). While crumbles
   come down, every non-quiet write that makes a cell load-bearing is also checked against them (§36.3.6).
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
1. Collapsing components are handled in the order they were found; after each one `ctx.now() ≥ ctx.deadline` leaves the rest
   for the next tick. A component of ≤ TREE_MAX_CELLS cells is re-read whole: only cells still load-bearing make the
   FloatingComponent `[q, y, r, id]` (none → skipped) for the tree test (a cell of it in an unloaded chunk by now: §36.3.5). A
   crumble goes CRUMBLE_SLICE cells at a time in (y, q, r) order (one numeric sort of `y·2^42 + packed column`), each slice re-read
   (cells no longer load-bearing are skipped): a big build comes down from the bottom over a few ticks — what is not down yet hangs
   meanwhile — instead of freezing one frame (an 8 000-cell box took 110–250 ms). It is committed once begun and LEAVES THE BATCH
   (FR-2 follow-up): its first slice comes down at once, the rest is a crumble of its own (`crumbleCount`), so the batch ends and
   later batches go on beside it — a tree cut during an 8 000-cell crumble used to wait 2–6 s (up to SUPPORT_LIMIT / CRUMBLE_SLICE
   ticks). Per step, while crumbles come down: a batch with work first gets BATCH_SHARE = ½ of what is left of the step
   (`ctx.deadline` lowered for it), then the crumbles take the rest, one slice each in turn (round-robin, resumed where the last
   step stopped), the deadline checked after each slice, at least one slice per step; once they are all down, budget still left
   goes back to the batches. A slice's instant part (its cells below `settle`) is written with `physics.coalesceMesh` set (World
   §9.2: those chunks re-mesh once per LAZY_COALESCE_UPDATES frames instead of once a tick); its animated part is not (the faller
   drawn there would show next to a stale copy).
2. Undo: the writes record into the seed's `event` while it is still `physics.lastEvent` (a blast's rim search records into the blast);
   otherwise into the batch's own event, opened once per batch with `beginEvent('collapse', seed.cause)` (later components and slices
   re-enter it; a big crumble chooses it at its first slice with a live cell). Its kind is `'falling tree'` while it holds only
   toppled trees and `'collapse'` once something crumbled. The batch's event is shared with the crumbles that outlive it.
   `cancelEvent(id)` (undo of that event) stops only what records into it: a crumble whose event is `id` — or, before its first
   live slice, whose seed's event or batch's event is `id` — is dropped with the cells it parked; the open batch's components still
   to come are dropped when its own event is `id`, and no component found from a seed whose `event` is `id` collapses
   (`batch.cancelled`, in any phase: the undo put back what cut it loose); cells parked into `id` are dropped. What still hangs
   stays where it is, like everything undo puts back; the rest of the batch and every other crumble go on (an undo used to end the
   whole batch, and the other collapses queued in it hung for good).
3. `tree = trees.test(component)`; `tree && trees.topple(tree, component, { cause, event })` → `stats.toppled++`; else the crumble:
   each slice is `fallers.crumble(instant, { event, settle: instant.length })` (with `coalesceMesh` set) then `fallers.crumble(rest,
   { event, settle: 0 })`, where `instant` holds the slice's cells among the lowest `settle = max(0, n − free slots when it began)`
   cells of the whole component — they settle instantly — and the rest animate (§34.2.4: the pile keeps its order across slices);
   once every cell is down, `trees.decayHangingLeaves` runs over the component's cells (256 at a time). The first slice that removed
   a cell counts `stats.crumbled++`, and the first such crumble of this SupportSolver (one per loaded world) says COLLAPSE_TIP
   (`tipSaid`). A BLAST_BARREL cell for which `ctx.explosions.hangBurning(q, y, r)` is true (it burns in place) is left out
   (integration, §38.2).
4. Rune blocks and black holes are never part of a component (not load-bearing): they stay where they are, and what rests on them
   lands on them. Campfires, water and anything else above follow through the normal triggers (§33.5). No boundary search follows a
   collapse: a component is maximal, so removing it cannot leave another load-bearing cell floating — except a cell that became
   load-bearing next to a crumble while it came down (§36.3.6).
5. Streaming (FR-2 follow-up): a collapse cell that reads UNLOADED when its turn comes — a cell of a crumble's slice, or any cell
   of a small component at its collapse (then nothing of that component collapses now) — is PARKED on its chunk (`ParkedCells {
   keys, cause, event, crumble }`; at most MAX_PARKED_UPDATES cells, beyond: `stats.parkedDropped`). A crumble's parked cells wait
   until it is down (a search of them meanwhile would meet its own hanging rest), then take its event. `onChunkGenerated(cq, cr)` —
   and the end of the crumble that parked them — re-seeds the cells parked on a chunk once it and its 6 hex neighbours are all
   loaded (a search must not stop on an UNLOADED cell next to them): ONE `seedSupport(cells, { cause, priority: cause is the
   player })` without removals inside `withEvent(event)`, so what it finds floating collapses outright (§36.2.3), into the original
   event while that is still undoable (`stats.resumed`). A crumble whose chunks unloaded part-way (the player teleporting away) used
   to leave the rest hanging for good: 7 616 of an 8 000-cell box.
6. What lands on a crumble: while crumbles come down, trigger 'support' takes every write but a quiet one (EXTERNAL or PHYSICS) that
   makes a cell load-bearing; each crumble — other than the one whose slice is being written (its own settling cells) — that still
   has to bring down one of the cell's 8 neighbours (its `order` from `at`, binary search) adds the cell to its `watch` set
   (`stats.watched`). When that crumble is done its watched cells are ONE seed without removals (its cause and event): a faller, log
   or other crumble that landed on the hanging part, or a block placed against it, would float once it was gone.
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
   centre (feet + height/2) is within TREE_KNOCK_RADIUS of a snapped log's DROP PATH — the vertical segment of cell centres from the
   snapped cell down to the cell it lands in (down while the cell below is fall-through), so a tree cut at eye level knocks the
   bodies it drops onto instead of lifting them onto the trunk (play-test G7) — is knocked once: `hooks.knock(body, TREE_KNOCK_SPEED ·
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
   taken by it. And when a support batch ends (after its collapses), the same `naturalOnly` test runs on the LOG cells each of its
   seeds took in as removals (`prevId` a log; seeds of an undone event skipped, `event` = the seed's): a canopy whose logs were
   chopped top-down, blasted or cut by an area command never toppled, and used to float forever (play-test G5). In the cluster
   test a load-bearing cell that itself rests on leaves (the cell under it is leaves — a felled log lying on a canopy) holds
   nothing (play-test G6).
2. A queued leaf decays after `LEAF_DECAY_S·(0.15 + 0.85·ctx.random())` s: when it still holds its id, `ctx.writeQuiet(AIR)` inside
   `enterEvent(event)` and 4 'leaves' particles; when the cell above it is load-bearing, `physics.seedSupport([[q, y + 1, r]])`
   (still inside the event), so a block that rested on the leaf comes down if nothing else holds it (G6). Leaves never become
   falling blocks.
3. `renderItems(push)`: every job (falling, then waiting) pushes each cell at `pivot + R(θ)·offset` with `tiltEuler(kx, kz, θ)`, scale 1
   (θ: 0 while waiting, `shakeAngle` while shaking).
4. support's `settleInto(overlay)` (after fallers'): the cells a collapse has not brought down yet — the rest of every crumble, the
   open batch's components still to come (not stale, not cancelled) and the parked cells — still load-bearing in the overlay are
   saved fallen, lowest first, down their columns (a burning barrel is explosions'); a cell of an unloaded chunk falls through that
   chunk as it will generate (`world.worldGen.generateChunk` with `world.edits` and the overlay's cells on top; a world without a
   worldGen saves it where it hangs). THEN the support work still waiting (while collapse is on) runs as ONE batch of a scratch
   SupportSolver that reads the overlay (`peekBlock` = `overlay.peek`; natural ground only where the overlay has no cell): the open
   batch's seeds when it has not decided yet (cancelled ones left out), `physics.pendingSupportSeeds()`, and per crumble a seed of
   its watched cells without removals (36.3.6). The same search and rule pick its components, whose cells are saved fallen the same
   way. A cut saved before its search ran used to hang forever after a reload, and later breaks found it "already floating"
   (play-test B1); so did a block placed against a crumble part-way down (G2). Nothing live changes (the seeds stay queued, the
   batch keeps its state), so a save costs one synchronous search of whatever is pending. Trees' `settleInto(overlay)` (saving;
   never the live world): per job, its logs snapped
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
14. A crumble outlives its batch, parks what streams out and re-searches what lands on it (§36.3.1, §36.3.5–6): DESIGN §5 crumbles a
    component in one call, so nothing could happen to a half-crumbled build there.

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
  occupiesCell(q, y, r) → boolean               // a lit barrel entity rests in that cell (§37.4.5; fallers treat it as solid)
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
   (q, y, r)`, `the barrel at (q, y, r) is already burning` (a fuse timer there, or a lit entity resting there — `occupiesCell`,
   37.4.5; it used to read "no blast barrel", play-test L1); else `lit the blast barrel at (q, y, r) — 3 s fuse`.
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
   refunds, flash and shake cleared (and the occupied cells of 37.4.5).
5. Occupied cells (play-test B3): each lit entity rests in the cell `floor(y + 0.05)` at its body's (q, r) (as 37.4.2 saves it),
   recorded when it is lit and rebuilt at the end of every `step` (also with dt 0). `occupiesCell(q, y, r)` is true while a lit
   entity still in `lit` rests there (one put out or gone off this frame no longer counts). Fallers treat such cells as solid
   (§34.2.2). A cell a barrel left since the last step (rolled, thrown, went off, put out and dropping) queues `(q, y + 1, r)` on the
   `fall` ring, so a pile that rested on the barrel falls into its cell.

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
4. Measured after the crumble follow-up (§36.3.1–§36.3.6; headless Chrome in real time on a shared machine, seed 42, a 20 × 20 × 20
   stone box on one pillar, 4 reps each, interleaved with the FR-2 build and the pre-FR-2 one): world.update during the crumble
   271–433 ms (FR-2: 674–889, pre-FR-2: 82–169), frame p50 5.6–7.7 ms (10.9–11.9; 4.2–5.1), 40–55 re-meshes (73–101; 12–24) —
   19–26 over the 75–114 frames its lowest cells settle, where FR-2 re-meshed every frame — worst physics step 9–35 ms (8.5–41;
   up to 272), nothing lost. A trunk cut 6 ticks into it falls after 1 tick (FR-2: 36); teleporting away 5 ticks in and back leaves
   0 of its 400 top cells hanging (FR-2: 400). Final stacks and edits equal FR-2's and the pre-FR-2 code's in the verifier's five
   equivalence scenarios on both clocks.

## 39. `src/zombies.js` (PURE) and `src/zombieRenderer.js` (three) — Zombies

A zombie is `createBody(x, y, z, { radius: ZOMBIE_RADIUS 0.27, height: ZOMBIE_HEIGHT 1.9, mass: ZOMBIE_MASS 1.2 })` plus
`{ id, yaw, targetYaw, mode: 'idle'|'walk'|'chase'|'avoid', timer, hurt, hits, walkPhase, groanIn, attackIn, swing, burn,
smoking, exposed, sunIn, fireIn, fireX, fireY, fireZ, detour, detourYaw, side (±1), stuck, tilt, wallSinceAim }`, moved by `stepPlayer` like a pig
(§30): it collides as its own cylinder, swims, hops one-cell ledges and feels `world.pullAt` (black holes + water currents, sampled
at feet + 0.5 exactly like pigs). The radius is just under PLAYER_RADIUS (< HEX_SIZE / 2), so a zombie fits through the player's
one-cell, two-high doorways. Each update first lifts a zombie that overlaps a solid cell (`findFreeY(…, floor(y)+1, 3)` with its
size). Zombies are night mobs: they are NEVER saved; the per-world switch is (`enabled`, below). There is no health anywhere:
nobody dies, a zombie is knocked out, burns away or is swallowed. Constants `ZOMBIE_*` live in config.js.
```js
export function openSky(getBlock, q, y0, r)       // no solid cell in column (q, r) from y0 to the top of the world
export function zombieVolume(zb, listener)        // 1 − d/ZOMBIE_SOUND_RANGE (3D distance), 0 at and beyond the range
export function loudestVolume(list, listener)     // max zombieVolume over list, 0 for none in range (one voice a frame)
export class Zombies {
  list, size, clear(), events                      // events: the ZombieEvents object update() returns (arrays reused)
  enabled; setEnabled(on) → changed?; switchVersion // the saved switch: off clears the list, summon and spawning refuse
  spawn(x, y, z, yaw = 0) → Zombie|null            // null when off, at ZOMBIE_MAX (16) or for non-finite input; mode idle
  remove(zb) → boolean
  update(dt, ZombieWorld) → ZombieEvents           // below
  hit(zb, fromX, fromZ) → 'hit'|'ko'|null          // the player's punch; null during the ZOMBIE_HURT_S flash
  knock(zb, vx, vy, vz) → 'hit'|'ko'               // a block-physics impulse (blasts, landing logs)
  raycast(ox, oy, oz, dx, dy, dz, maxDist) → { zombie, distance }|null   // cylinder ZOMBIE_TARGET_RADIUS 0.3 × ZOMBIE_HEIGHT
  spawnHeightAt(world, q, r) → feet y|null         // the natural-spawn test for one column
}
/** ZombieWorld = { getBlock, isLoaded(x, z), player?, isDay?, pullAt?, hasCampfires?, nearestFire?(x, y, z, maxDist, out) → dist|∞,
 *    isLoadedCell?(q, r), groundHeight?(q, r) (World.terrainHeightAt), isNaturalGround?(q, y, r), columnEdited?(q, r) }
 *  ZombieEvents = { attacks, groans, ignited, burned, knockedOut, scorched, spawned: Zombie[], despawned: number } */
```
### 39.1 Update (normative order)
1. **Natural spawning** (only while `enabled`, a player exists, `!isDay` and `groundHeight` is given): `_spawnIn` counts down; at 0 it
   is reset to ZOMBIE_SPAWN_INTERVAL_MIN_S + rng·(MAX − MIN) (8–20 s: a few zombies a minute) and one attempt runs: 1 zombie, or 2
   with probability 0.35 (the second 1.5–3.5 from the first), over at most ZOMBIE_SPAWN_TRIES (12) random columns at a horizontal
   distance ZOMBIE_SPAWN_MIN 16 … ZOMBIE_SPAWN_MAX 40 from the player (cell centre at least 16 away), while fewer than ZOMBIE_MAX
   exist. `spawnHeightAt` accepts column (q, r) when it is loaded, h = `groundHeight(q, r)` ≥ 0 with h + 3 < WORLD_HEIGHT,
   `isNaturalGround(q, h, r)` (untouched, solid), cells h + 1 and h + 2 are AIR (no water, fire, logs or leaves there),
   `columnEdited(q, r)` is false (never in a column the player has built in: houses are safe), no campfire within
   ZOMBIE_SPAWN_FIRE_CLEAR (8) of the floor centre at h + 1, and the body is free there; it stands at h + 1 facing the player ±90°.
2. Per zombie (list walked from the end): y < −16 → removed; horizontal distance to the player > ZOMBIE_DESPAWN_DIST (80) →
   removed (`despawned`); chunk not loaded → frozen (skipped); unstick.
3. **Daylight**: while `isDay`, every SUN_CHECK_S (0.25 s; the first check after night is immediate) `exposed` = not wet (inWater,
   or liquid at floor(y + 0.1) or floor(y − 0.5): a swimmer bobbing out of the surface) and `openSky(column, ceil(y + height))`.
   Exposed: `smoking` (the first frame reports `ignited`), `burn += dt`, and at ZOMBIE_BURN_S (4) it is removed (`burned`). Not
   exposed (shade, water, night): `smoking = false`, `burn` cools by dt. So a zombie in shade survives until it walks into light.
4. **AI** (`_think`), `canHop` as for pigs (§30: no carrier, carrying nobody — from the end of last frame):
   - Campfires are safe zones: the **zone** of a campfire is everything within ZOMBIE_FIRE_FEAR (4) of its floor centre, measured
     from a body's y + 1 (`nearestFire(x, y + 1, z, …)`; on the fire's own level a horizontal radius of √15 ≈ 3.87). Every
     FIRE_CHECK_S (0.2 s), while `hasCampfires()`, a zombie looks up the nearest fire within ZOMBIE_FIRE_FEAR + FIRE_WATCH (2) and
     remembers its floor centre in `fireX, fireY, fireZ` (fireX NaN: none; also NaN while `hasCampfires()` is false); when it is
     inside that fire's zone it turns straight away from it, mode `avoid` for AVOID_S (0.8 s) at chase speed; it stops early (idle)
     when, facing its heading, the way ahead is unsafe (below). Between checks it steers by the remembered fire (`_intoFire`,
     below), so a chaser walks along the edge of a zone instead of into it. Nobody inside a zone is struck (step 7).
   - **Chase** (`_canChase`): the player exists, is not flying, is at most ZOMBIE_CHASE_MAX_RISE (5) above the zombie's feet and
     within ZOMBIE_SIGHT (24, 3D). Entering chase moves the next groan to 0.2–0.8 s. Heading: straight at the player (kept when
     closer than 0.35 horizontally), or the detour heading while a detour runs. Whenever it would step (on the ground, heading within
     MOVE_CONE 1.2 rad of its yaw) and the way ahead is unsafe, a **detour** starts: `detourYaw = yaw + side·(π/3)(1 + rng)` for
     DETOUR_S + rng·DETOUR_RAND_S (0.5–1.1 s), always toward the zombie's own `side` (chosen at spawn), so repeated blocks walk it
     around an obstacle; pressing into a wall it cannot hop for STUCK_S (0.25 s) also starts one. A chaser in water swims straight
     at the player.
   - Otherwise in water: swim for the nearest bank exactly like a pig (`pigs.shoreYaw`, re-aimed every SWIM_REAIM_S, at most
     ZOMBIE_SHORE_SEARCHES (1) searches per update); else idle ↔ walk like a pig (idle 1–5 s, walk 1.5–5.5 s within ±π), a walking
     grounded zombie whose way ahead is unsafe stops (0.5–1.5 s) and turns away by 0.5–1.5π.
   - **Unsafe ahead** (`_safeAhead`, the cell 0.8 along the yaw, feet level fy = floor(y + 0.01)): water it would swim in
     (`isSwimWater`; wanderers only — a chaser wades in after you); a campfire on its next steps (`pigs.fireAhead`, the pig rule
     §30 step 3, skipped while `hasCampfires()` is false); a step deeper into the remembered fire's zone (`_intoFire`, skipped
     while `hasCampfires()` is false: the point 0.8 along the yaw is within ZOMBIE_FIRE_FEAR of (fireX, fireY, fireZ), measured
     from y + 1, and nearer to it than the zombie is; walking out of a zone or along its edge is fine); a solid cell unless
     `canHop` and fy + 1, fy + 2 are open (`pigs.isOpen`: a one-cell ledge with room for its height); a solid cell at fy + 1 over
     an open fy (too low); a drop of more than ZOMBIE_MAX_DROP (3) cells: no solid cell at fy − 1 … fy − (ZOMBIE_MAX_DROP + 1)
     (ground at fy − d is a drop of d − 1 cells; liquid met first counts as ground for a chaser only, and ends the search as
     unsafe for anyone else). So a zombie walks down a 3-cell drop and never off a 4-cell one.
5. **Move**: turn toward `targetYaw` at ZOMBIE_TURN_RATE (3.5 rad/s); step forward only when not idle, not hurt (stunned), not right
   under/over the player and within MOVE_CONE of the heading — `forward` ZOMBIE_CHASE_SPEED (0.82 × WALK_SPEED ≈ 3.5 m/s, the
   player walks 4.3) in chase / avoid, else 1 with `sneak` (1.31 m/s shamble); `jump = inWater || (moving && hitWall && canHop &&
   a one-cell ledge with two open cells on it straight ahead)`. `walkPhase` advances by 3.2 × distance (mod 2π) and settles to a
   multiple of π below 0.2 m/s.
6. **Campfire scorch**: a zombie (not flashing) whose feet cell floor(y + 0.05) is a CAMPFIRE is `hit` from the cell centre —
   `scorched`, or `knockedOut` (removed) when that was its last hit.
7. **Attack**: not hurt, `attackIn` ≤ 0, not in `avoid`, the player not riding this zombie (`player.carrier !== zombie`), within
   ZOMBIE_REACH (1.3) horizontally, heights overlapping (the player's feet more than ZOMBIE_REACH_OVERLAP 0.1 below the zombie's
   top, so a rider sunk a few mm into its head is never struck), and
   no solid cell at chest height (the mean feet + 1.2) at 1/3 and 2/3 of the way; then, while `hasCampfires()`, two live
   `nearestFire` look-ups (never the remembered fire): the player inside a zone refuses it (looked up once per update, at the first
   strike due), and the zombie inside a zone refuses it and starts `avoid` away from that fire (as in step 4) — so a strike needs
   both outside every tracked campfire's zone, and a player standing in a zone (on the fire's level: within 3.87 of it, the fire's
   cell and its three rings) is never struck. A refused strike keeps `attackIn` ≤ 0. A strike SETS the player's horizontal
   velocity to ZOMBIE_HIT_PUSH (6 m/s) straight away from the zombie, `vy = max(vy, ZOMBIE_HIT_LIFT 4)`, `onGround = false`;
   `attackIn = ZOMBIE_ATTACK_COOLDOWN_S` (1), `swing = SWING_S` (0.35 s, the renderer's lurch); reported in `attacks`. No damage in Creative; in Survival main deals
   ZOMBIE_DAMAGE (8) per strike (§45, §49) — zombies.js stays mode-agnostic and the push is unchanged.
   Zombies never attack pigs.
8. Groans: `groanIn` counts down; due → reported (`groans`), reset to 3–8 s while chasing, else 6–16 s.
`hit(zb, fromX, fromZ, power = 1)` (v0.9: the tool's power, §45; anything not a positive number counts 1): ignored (null) while
`hurt > 0`; `hits += power`; the ZOMBIE_HITS-th (4) hit removes it ('ko'); otherwise velocity
ZOMBIE_KNOCKBACK (6.5) away from the hitter, `vy ≥ ZOMBIE_KNOCK_LIFT` (4.5), `hurt = ZOMBIE_HURT_S` (0.45 s: red flash and stun,
`attackIn ≥ hurt`), detour cleared. `knock(zb, v)`: |v| ≥ ZOMBIE_KO_KNOCK (9 m/s) removes it ('ko') — a blast's §37 impulse
BLAST_IMPULSE·(1 − d/2R) reaches that within about the blast radius R (its BLAST_MIN_UP floor adds a little); weaker knocks add the
velocity and count as a hit (unless flashing), which can also be the knock-out.
### 39.2 Rendering
`createZombieRenderer(scene, atlasTexture, capacity = ZOMBIE_MAX)` → `{ sync(zombies), count(), dispose(), group }`. The model
faces −Z with its origin at the feet (matrix translate(x, y, z) · rotateY(yaw), like pigs) and is four hexagonal prisms from
`hexPrismGeometry(R, h, y0, { front, sides, top, bottom })` (corners at 60°·k from +X toward +Z, so side face 4 — normal −Z — is the
front; each side shows a whole atlas tile upright and unmirrored seen from outside, caps an inscribed hexagon; UV_INSET):
two feet (R FOOT_R 0.145, h 0.56, centres ±FOOT_X 0.152 — together as wide as the torso — hanging from the hip so they swing ±0.55
rad with sin(walkPhase) in opposite phase; `zombie_trousers` sides and top, `zombie_sole` below), a torso on the hips (R 0.3,
h 0.76, `zombie_shirt` all round; leaning −0.05 rad, −0.14 in a chase, plus a −0.32·sin(π·swing/SWING_S) lurch after an attack, and
swaying with the stride) and a head on the torso (R 0.28, h 0.58: the face tile `zombie_face` on the FRONT side only,
`zombie_head_side` on the other five and below, `zombie_scalp` on top; rolled by its own `tilt` and nodding with the stride);
0.56 + 0.76 + 0.58 = ZOMBIE_HEIGHT. Draw calls: three InstancedMeshes in group `zombies` — `zombie-feet` (2 per zombie),
`zombie-torso`, `zombie-head` (MeshLambertMaterial, map = the atlas, a faint self-light `emissive NIGHT_GLOW 0x8c8c8c ×
emissiveMap = the atlas` that keeps them readable at night) — and their twins `-hurt` (emissive 0xff2a2a × 1.6 through the
texture: zombies with `hurt > 0`) and `-burn` (colour 0x8a7c72 soot, emissive 0xff6a1a × 0.9 through the texture: `smoking`
zombies), so any number of zombies costs 3 draw calls (up to 9 while some flash or burn); meshes with no instances are hidden;
frustum culling off. Tiles (tiles.js recipes are normative; original art, alpha 255; atlas row 15, not block faces): 240
`zombie_face` (grey-green rotting skin, matted fringe, a stitched forehead scar, two dark eye sockets with a sickly yellow glint —
the right one droops — nostril holes, a crooked dark mouth with two pale teeth), 241 `zombie_head_side`, 242 `zombie_scalp`, 243
`zombie_shirt` (faded teal, two tears showing skin, a stain, a torn hem), 244 `zombie_trousers` (ragged brown, frayed hem, bare
ankle, battered dark shoe), 245 `zombie_sole`. Side faces are about twice as tall as wide, so features are drawn short and wide.
### 39.3 Integration
main: ONE `Zombies` for the session. `startLoading` clears it and sets `setEnabled(save?.zombies !== false)` (new worlds and saves
from before zombies: on); `buildSaveData` writes `zombies: zombies.enabled`; autosave also fires when `switchVersion` changed;
`quitToTitle` / `dispose` clear it. `stepZombies` runs right after `stepPigs`: `zombieWorld.player = player`, `isDay =
daynight.isDayTime(time)`, `update(dt, zombieWorld)` (getBlock / isLoaded / pullAt / hasCampfires shared with pigs; `nearestFire`
over the tracked `campfires.fires`; `isLoadedCell` = hasChunkAtCell, `groundHeight` = World.terrainHeightAt, `isNaturalGround`,
`columnEdited` = blackholes.columnHasEdits(world.edits, …)); an attack sets the HUD hurt flash to 1 (fading over HURT_FLASH_S 0.45 s
in renderFrame, `hud.setHurtFlash`) and plays `audio.playThud(1)`; at most one groan a frame within ZOMBIE_SOUND_RANGE (24, volume
`zombieVolume` = 1 − d/24); `ignited` → ONE playHiss a frame and `scorched` → ONE playZombieHurt a frame, each at
`loudestVolume(list, player)` (a crowd ignites on the same frame at dawn); `burned` / `knockedOut` → `zombieGone` (a puff: dust
grey-green for a knock-out, ash + smoke + sparks for a burn), which only raises `zombieDownVolume` to its `zombieVolume`: ONE
`playZombieDown(zombieDownVolume)` a frame, the loudest, played in `stepBlockPhysics` after the physics step like `knockSqueal`
(so punches, burns, black holes and blasts on one frame are one voice); smouldering zombies emit smoke (and now and then a spark)
every frame; zombies a black hole swallows (`blackHoles.swallowing(zb)`) are removed with a puff. `resolveBodies([player, pigs…, zombies…, lit barrels…])` (loaded
chunks only) and PhysicsHooks.bodies include them, so they push and are pushed, can be stood on and are lifted out of landing blocks.
PhysicsHooks.knock on a zombie → `zombies.knock` (a 'ko' puffs it away). `updateHit` ray-casts zombies after pigs, up to the pig's
or block's distance; a zombie in front takes the crosshair (target hint `Zombie · click: hit it`), lit barrels in front of it take
it from the zombie; `breakTargeted` hits it (`playZombieHurt`, or `zombieGone` on 'ko'). `placeSelected` refuses a solid block
that would intersect a zombie. `game.teleport` also `detachBody(player, zombies.list)`; `game.zombies` and the debug handle's
`zombies` expose the instance. Pause menu: `#pause-creatures.physics-row` (label "Creatures", below the Undo button) with
`#btn-zombies` ("Zombies: ON|OFF", class `off`, aria-pressed; `menus.setZombiesState(on)` after `showPause`); `onZombiesToggle`
flips the switch (off removes every zombie), click + toast. The CommandContext gets `zombies`.

## 40. `src/watcher.js` (PURE) and `src/watcherRenderer.js` (three) — the Hollow Watcher

Caelancraft's own legend (original: nothing about it borrows another game's character): a figure (WATCHER_HEIGHT 2.6) built
from the world's own cell shape — a floating stack of hollow hexagonal rings of weathered ash-grey stone with thin glowing cyan
cracks, a hex lantern for a head with two small cyan lights inside that shine through fog and darkness, and a wisp of dark smoke
trailing to the ground where legs would be (§40.4). It is a SIGHTING, not a creature: at most one exists, it is never a body (no
collisions, not in `resolveBodies`, not targetable), it never moves, never attacks and never writes a block while it is there — only
its head turns. The figure is never saved; the world keeps the per-world switch (`enabled`, §14 `watcher`) and the night of the last
natural sighting (`lastNight`, §14 `watcherNight`). Its tunables `WATCHER_*` live in watcher.js (exported; nothing else reads them).
```js
export function nightKey(time, day)          // t ≥ 0.75 → day, else day − 1: one key from dusk to the next dusk (main bumps day at midnight)
export function blocksSight(id)              // isOpaque(id) || isLeaves(id): air, water and glass let sight through
export function lineOfSight(getBlock, ex, ey, ez, tx, ty, tz)   // raycastHex(…, d − 0.35, blocksSight) === null (d ≤ 0.35 → true)
export function isDeepUnderground(world)     // eye y ≤ groundHeight(player column) + 1 − WATCHER_CAVE_DEPTH (8) and a solid cell above the eye
export function viewTangents(world, fovDeg = world.fov) → [tanH, tanV]   // tan of half the view: tanV = tan(fov / 2) (fov: fovDeg, else config FOV 70°),
                                             // tanH = tanV · aspect (world.aspect, else WATCHER_DEFAULT_ASPECT 16 / 9)
export function screenPos(world, x, y, z, out, fovDeg = world.fov) → boolean   // out = [sx, sy]: the point's camera-space x and y over its depth, divided by
                                             // tanH / tanV (|s| ≤ 1 on screen); false behind the eye (§40.1.2)
export function inView(world, x, y, z, margin = 0, fovDeg = world.fov) → boolean   // screenPos and |sx|, |sy| ≤ 1 − margin
export function surfaceFeetY(world, q, r) / caveFeetY(world, q, r, fy)   // standing spots (§40.1.2)
export function traceWritable(world, q, y, r) // y in range, loaded, no edit (hasEdit false), ≥ WATCHER_SPAWN_CLEAR (16) from `spawn`,
                                             // not in the player's body, not occupied()
export function planPillar / planDeadFire(world, x, y, z, rng), planUproot(world, x, y, z), planUprootAt(world, q, h, r) → WatcherTrace|null
export function planTrace(world, x, y, z, rng, kinds = TRACE_KINDS) → WatcherTrace|null   // TRACE_KINDS = ['pillar', 'deadfire', 'uprooted']
export class Watcher {
  constructor(rng = Math.random)
  figure: WatcherFigure|null; present; events   // events: the WatcherEvents object update() returns (reused)
  enabled; setEnabled(on) → changed?; switchVersion   // off removes the figure at once (no puff, no trace), nothing appears, summon refuses
  clear()                                      // a new world: no figure, no pending roll, no night used (the switch is kept)
  lastNight → number|null; setLastNight(n) → accepted?   // the night of the last natural sighting (saved: §40.4); n a whole number ≥ 0 or null
  sightingMode(world) → 'cave'|'night'|null    // null with no player or the head under water; 'cave' when isDeepUnderground; 'night' when !isDayTime
  findSpot(world, cave, { edgeMin?, edgeMax?, hiddenOk? }?) → { x, y, z, los }|null
  summon(world) → WatcherFigure|null; summonAt(world, q, y, r) → WatcherFigure|null   // kind 'summon', any time of day
  update(dt, world) → WatcherEvents
}
/** WatcherWorld = { getBlock, isLoadedCell(q, r), groundHeight(q, r) (World.terrainHeightAt), isNaturalGround(q, y, r), hasEdit(q, y, r)
 *    (without it no trace is made), occupied?(q, y, r) (a creature's body), player, eye: [x, y, z], look: [dx, dy, dz] (unit), yaw,
 *    fov? (the vertical FOV, degrees, a sighting must START inside), viewFov? (the camera's real vertical FOV now; fov when absent:
 *    the seen test, §40.2), aspect? (width / height), time, day, fogFar, spawn?: [x, z]|null }
 *  WatcherFigure = { x, y, z (feet: its cell centre), q, r, yaw (faces the player as it appears; never changes), headYaw, headPitch,
 *    kind: 'night'|'cave'|'summon', los, age, gaze, unseen, seen, wispIn }
 *  WatcherEvents = { appeared: WatcherFigure|null, vanished: { x, y, z, reason: 'gaze'|'near'|'unseen'|'dawn'|'unloaded', trace }|null, wisp }
 *  WatcherTrace = { kind, at: [q, y, r], writes: [q, y, r, id][] (main applies them in order) } */
```
### 40.1 Appearing
1. `update(dt, world)` (nothing for `dt ≤ 0` or no player): with a figure present it only runs §40.2. Otherwise, while `enabled`:
   `key = nightKey(time, day)`; a new key drops a pending roll. A remembered night AHEAD of `key` (the console's `time set` rewinds
   the hour but keeps the day; a bad save) becomes `key`: it counts as tonight — no second sighting in the night the player is in,
   and no block on the nights to come. Nothing more when `sightingMode` is null or `key` is the key of the
   last natural sighting (**at most one per in-game night**). Every WATCHER_CHECK_S (5 s) of such time one check: unless a roll is
   already pending, `rng() < WATCHER_CHECK_CHANCE` = 1 − (1 − WATCHER_NIGHT_CHANCE ⅓)^(5 / 300) ≈ 0.00673 makes one pending — so a
   night (DAY_LENGTH_SECONDS / 2 = 300 s, ~5 real minutes, 60 checks) brings a sighting with probability ⅓; a pending roll is placed
   by `findSpot(world, mode === 'cave')` at this and every later check of the night until a spot is found — a natural sighting
   **only ever starts on screen and in sight** (§40.1.2), so while there is none (walled in, a cave, looking at the ground) the roll
   stays pending instead of being spent on a figure nobody could see. Placing it records the key (`lastNight`), reports `appeared`
   and returns — **it never vanishes on the update it appears in**. The key is saved with the world (§40.4), so a reload in the
   same night brings no second sighting while the next night still can (main saves `time` and `day`, so the key is the same after
   a reload).
2. `findSpot(world, cave, { edgeMin = WATCHER_EDGE_MIN 0.4, edgeMax = WATCHER_EDGE_MAX 0.85, hiddenOk = false })`:
   `dMin = max(WATCHER_MIN_DIST 30, WATCHER_FOG_MIN 0.75 · fogFar)`, `dMax = WATCHER_FOG_MAX 0.95 · fogFar` (main's fogFar is
   `fogRangeForRenderDistance(rd).far`: 27.7 at rd 3 → no spot at all, 41.6 at rd 4, 83.1 at rd 7); none when dMin > dMax (or without
   player, eye or look). Up to WATCHER_PLACE_TRIES (24) columns: aim at yaw ± atan(u · tanH · cos(pitch)) with u = edgeMin … edgeMax
   — the point at the horizon u of the screen's half-width out from its middle (`viewTangents`; cos(pitch) = |look| in the
   horizontal plane): natural sightings toward the edge of the view, the corner of the eye (≈ 26°–47° aside in a 16:9 window at
   FOV 70°) — at a distance dMin … dMax, take that point's cell, which must be loaded with its
   centre within dMin … dMax horizontally; feet = `caveFeetY(…, floor(player y))` in a cave (the nearest level fy, fy + 1, fy − 1, …
   within WATCHER_CAVE_SPAN 8 with a standable floor — solid, not leaves, not liquid — and three AIR cells) else `surfaceFeetY` (the
   highest standable cell from groundHeight + 8 down to groundHeight − 6, and only if three AIR cells stand on it); 3D distance ≥ 30;
   and **on screen**: its feet (x, y, z) and the top of its head (y + WATCHER_HEIGHT) both `inView(…, WATCHER_VIEW_MARGIN 0.1)` —
   inside the camera's view (screenPos: the eye, `look`, no roll, as main's camera is rotated (pitch, yaw, 0) 'YXZ'; `fov` and
   `aspect` from WatcherWorld, config FOV 70° and 16 : 9 when absent) shrunk by 10 % of its half-width and half-height, so the
   vertical counts too (looking at the ground the horizon is off screen: no spot). The first such spot with line of sight (eye → its
   eyes at WATCHER_EYE_Y 2.38, or its centre at 1.3) wins; none in sight → null — natural sightings never fall back to a hidden spot
   (play-test: underground nearly every sighting appeared where it could not be seen and went 30 s later, using up the night). Only
   `hiddenOk` (summon) takes the first in-view spot without line of sight (`los: false`). It faces the player (`yaw = headYaw`
   toward the player).
3. `summon(world)` (a testing command): enabled, none present, a player → `findSpot(world, isDeepUnderground(world), { edgeMin:
   tan(WATCHER_SUMMON_SIDE_MIN 8°) / tanH, edgeMax: tan(WATCHER_SUMMON_SIDE_MAX 25°) / tanH (both at most 1 − WATCHER_VIEW_MARGIN),
   hiddenOk: true })`: 8°–25° aside on screen (plainly in view, never dead centre), and on screen like a natural one. A spot in
   sight is preferred; only when there is none (walled in, a cave) it stands hidden in the view (`los: false`; the console says
   "(out of sight)"; it goes after WATCHER_UNSEEN_S like any sighting nobody sees), so it can still be tried anywhere. Nothing in
   view (the horizon off screen, a fog far too short) → null. It does NOT use up the night's natural sighting. `summonAt(world, q,
   y, r)`: feet at (hexToWorld(q, r), y), wherever that is (`los` says whether it is in sight).
### 40.2 While it is there, and vanishing (the order of checks per update)
`age += dt`; its chunk unloaded → gone (`unloaded`: no puff, no trace); the player within WATCHER_NEAR_VANISH (20, 3D feet to feet) →
`near`; a `night` sighting once `isDayTime` (and the player is not deep underground) → `dawn`. Seen: it is ON SCREEN (`seen`) when
its centre (y + 1.3) or its eyes (y + WATCHER_EYE_Y) is `inView` (margin 0, fovDeg = `viewFov` — the camera's real view now, wider
while sprinting, and its window — not a cone,
so 48° aside is on screen in a 16:9 window and 40° above the view's middle is not) with line of sight to that point (rays only for a
point on screen); `cos` of the angle between `look` and eye → its centre inside WATCHER_GAZE_CONE (6°) with line of sight to its
CENTRE: the player is looking straight at it: `gaze += dt` (else `gaze = 0`), and at
WATCHER_GAZE_S (0.4 s) → `gaze`. `unseen` = seconds since it was last on screen; at WATCHER_UNSEEN_S (30 s) → `unseen`. Then its head
turns toward the player at WATCHER_HEAD_TURN_RATE (0.6 rad/s), at most WATCHER_HEAD_MAX_TURN (1.3 rad) from the body's yaw, and tilts
toward the player's eye (±WATCHER_HEAD_MAX_PITCH 0.35) at the same rate; every WATCHER_WISP_MIN_S … MAX_S (1.2–3.6 s) `wisp` is
reported. It never changes x, y, z or yaw, never touches the player and has no way to write a block. Vanishing reports
`{ x, y, z, reason, trace }` where trace = `rng() < WATCHER_TRACE_CHANCE (0.35) ? planTrace(world, x, y, z, rng) : null` (never for
`unloaded`).
### 40.3 Traces (`planTrace`: a random kind first, then the others in random order — Fisher–Yates over `kinds` — the first that fits)
Plain world edits, applied by main in order with `World.setBlock` (so they are saved and trigger block physics like any external
write; they are not physics events and `undo` does not take them back). **A trace only ever changes untouched natural terrain and
natural trees** (play-test: an uprooting turned a player's block under a root into dirt — deleting a Rune Block — and pillars filled
player-dug shafts): every cell it writes and every cell it relies on has no edit (`hasEdit` false; `isNaturalGround` cells are
unedited by definition), so a placed block, a dug hole or shaft (edited AIR), a Rune Block or anything else the player made is never
written, filled or stood on. Every written cell passes `traceWritable` (so also never the player's cell, never a creature's, never
within 16 of spawn) and none has a liquid among its 8 neighbours. Each kind is laid out so it cannot bring anything else down:
- `pillar`: WATCHER_PILLAR_MIN … MAX (4–6, from rng) OBSIDIAN cells stacked on natural ground, bottom first, every one AIR before.
  The column: the figure's own cell, then the rings 1 … WATCHER_TRACE_NEAR (3) around it (each ring walked from a random cell), each
  with its ground = the highest `isNaturalGround` cell from floor(y) + 1 down to floor(y) − 4, kept when UNTOUCHED AIR (no edit)
  stands on it — the floor of a hole or shaft the player dug is not open ground, and every obsidian cell is untouched AIR. `at` = the
  bottom obsidian cell. Nothing is removed, so nothing can fall.
- `deadfire` (a dead campfire, never a lit CAMPFIRE): in the first such column with ground g ≥ 1 whose g + 1, g + 2 are untouched
  AIR and g − 1 standable and unedited (the ash never rests on a player's block), and whose six neighbours all have natural ground at
  exactly g with untouched AIR at g + 1 and g + 2 (never in a pit the player dug): COBBLESTONE on the six neighbours at g + 1 (faces
  0..5), then the centre floor (q, g, r) → GRAVEL (cold ash; it rests on a solid cell, so it never falls). `at` = [q, g, r]; the
  centre cell above stays empty.
- `uprooted`: the nearest (horizontal distance to the trunk centre ≤ WATCHER_TREE_RANGE 8; ties by q, r) column whose cell over
  `groundHeight` h is a log for which `planUprootAt(world, q, h, r)` holds: h ≥ 1, natural ground at h, a single trunk of
  WATCHER_TRUNK_MIN … MAX (3–8) unedited logs from h + 1 crowned by leaves; against every trunk cell AND the root only natural
  ground, leaves or non-solid cells (no build hangs on it or is set into the ground beside its root, no other trunk touches it —
  else this tree is skipped), no liquid; the cell under the root standable, unedited natural ground. **An edited root or cell under
  it skips the whole tree** (not just the dirt write): with a player's block under the root — a Rune Block, a tunnel's ceiling — the
  hole alone would still open onto it and the tree no longer stands on untouched ground; another tree or kind is taken instead.
  Its leaves: unedited leaves in columns within WATCHER_LEAF_RADIUS (2) of the trunk from the top log − 1 to + 3, except
  those with another UNEDITED log (any y within ±3) in a column at a hex distance ≤ their own distance from the trunk (shared or
  nearer leaves stay with that natural tree; a log the player placed, or one felled onto the canopy, keeps none — it holds nothing
  up; the player's own leaves stay too); the whole canopy must be loaded and writable; no edited cell that it leaves rests on one it
  removes (the player's gravel on a leaf would fall — the tree is skipped); and the leaf decay block physics runs on the removed logs
  afterwards (§36.6.1 — mirrored on the world as the trace leaves it: clusters of leaves next to the logs, through leaves, that touch
  no unloaded cell and no load-bearing cell other than one resting on leaves) must find nothing but AIR or leaves on any natural leaf
  that would decay — else the tree is skipped (a review found player blocks on such leaves falling 6 cells). Writes: the leaves top
  down → AIR, the logs top down → AIR, the root (q, h, r) → AIR and (q, h − 1, r) → DIRT unless it already is: a hole over dirt
  where the tree stood. `at` = [q, h, r].
  Logs and the root are removed together in one frame, so the support search finds nothing floating (§36.2) and no tree topples.
### 40.4 Rendering and integration
`createWatcherRenderer(scene, atlasTexture)` → `{ sync(figure|null, camX, camY, camZ, time), visible(), prewarm(webgl, camera),
warmPending(), dispose(), group, head, rings, lantern, core, smoke, eyes, glows }`: ONE group `watcher` of 12 parts (10 meshes, 2
sprites — it is one figure, so a handful of draw calls), hidden when `figure` is null; origin at the feet (the cell floor),
translate(x, y, z) · rotateY(yaw), facing −Z like the zombies. Built from the world's cell shape and hollow; nothing humanoid (no
legs, arms or face). `time` (s; main passes fxTime) drives the rings, the smoke and the pulse.
- Body: RING_COUNT 5 open hex rings `watcher-ring-0..4` — thin-walled hex bands (outer circumradius RING_R = [0.19, 0.26, 0.3, 0.26,
  0.2], widest in the middle; wall RING_WALL 0.035 across the flats; height RING_H 0.12; nothing across the middle), pointy-top like
  the cells at rest (corner 0 at −30°) — floating with RING_GAP 0.14 open between them: ring i's underside at `ringBaseY(i)` =
  RING_BASE_Y 0.72 + i·(RING_H + RING_GAP) + RING_BOB 0.02 · sin(2πt / RING_BOB_S 5.5 − RING_BOB_STEP 1.1 · i), turned
  RING_PHASE[i] + RING_SPIN[i]·t about its axis (RING_PHASE [0, 0.33, 0.12, 0.47, 0.21], RING_SPIN [0.045, −0.03, 0.02, −0.035,
  0.05] rad/s: each its own slow way). WATCHER_CENTRE_Y 1.3 falls on the middle ring.
- Head: the pivot `watcher-head-pivot` at HEAD_Y = RING_BASE_Y + 5·RING_H + 4·RING_GAP + NECK_GAP 0.16 = 2.04 (rotation 'YXZ' =
  (headPitch, headYaw − yaw, 0)) holds a hex LANTERN, LANTERN_H 0.56 tall (HEAD_Y + LANTERN_H = WATCHER_HEIGHT), flat front (corner 0
  on +X, so side 4 faces −Z): `watcher-lantern`, a heavier rim top and bottom (R LANTERN_R 0.22, wall LANTERN_WALL 0.05, height
  LANTERN_RIM_H 0.07) and six slim corner posts (hex prisms R POST_R 0.017) on the rims' middle line, its sides open; inside,
  `watcher-core`, the dim inner glow (hex prism R CORE_R 0.075, pivot y CORE_Y 0.24 … + CORE_H 0.2; MeshBasicMaterial CORE_COLOR
  0x0f4c55, opacity CORE_OPACITY 0.55 · (1 + 0.5 · CRACK_PULSE · the pulse), normal blending, depthWrite false, fogged — a faint teal
  light at night, a muted crystal by day); in front of the core, inside the front window, the two lights `watcher-eye-l/r`: small
  pointy-top hexagons (CircleGeometry(EYE_R 0.021, 6, π/2)) at (±EYE_X 0.045, WATCHER_EYE_Y, EYE_Z −0.14),
  `MeshBasicMaterial({ color: EYE_COLOR 0x7ff8ff, fog: false })` — unlit and fog-free, so they stay bright through fog and darkness:
  the only bright features — and a Sprite each (`watcher-glow-l/r`: a 32×32 DataTexture radial glow, `color GLOW_COLOR 0x39d8f0,
  fog: false, depthWrite: false, Additive`) scaled `max(GLOW_MIN 0.16, distance · GLOW_PER_M 0.012)` m (about six pixels at 720p,
  however far), its opacity breathing 0.9 ± 0.1. Intended: at sighting distances (30–80 m; it is gone within WATCHER_NEAR_VANISH 20 m)
  the two glows overlap (glow width / light spacing = d / 7.5 ≥ 4), so a player sees ONE cyan point at the top of a faint column;
  the two lights only separate up close (summonAt at a few metres, screenshots).
- Smoke: `watcher-smoke`, three stacked hex tubes under the lowest ring (SMOKE: y 0.46…0.7, 0.24…0.44, 0.02…0.22 above the feet;
  radius 0.11 → 0.025 and vertex alpha 0.4 → 0.04 shrinking toward the ground), watcher_smoke texels, MeshBasicMaterial(map,
  vertexColors with alpha, transparent, depthWrite false, DoubleSide, forceSinglePass), turning SMOKE_SPIN 0.3 rad/s.
- Stone: the rings and the lantern share ONE MeshLambertMaterial(map = the atlas, vertexColors = a shade per face: 1 outer walls,
  0.9 tops, 0.72 undersides, 0.5 inner walls, so the hollow reads; emissive white × emissiveMap = a clone of the atlas — same Source,
  so one GPU texture — with offset (TILE_UV, 0): every stone texel's glow is read from the tile to its right, watcher_cracks),
  emissiveIntensity CRACK_GLOW 0.75 · (1 + CRACK_PULSE 0.35 · sin(2πt / CRACK_PULSE_S 6.5)) — the cracks pulse slowly. Untextured
  (tests): colour 0x8b8984, no emission. Every face shows a window of its tile, FACE_PX 12 pixels along its longer side and as many
  along the other as keep the texels square, placed (and mirrored) by a per-face seed, so the cracks fall differently on each face.
Tiles (tiles.js recipes are normative; original art, alpha 255; atlas row 15, not block faces): 250 `watcher_stone` (weathered
ash-grey stone 0x8a8884, mottled and porous, with two short thin cracks as dark teal-grey grooves), 251 `watcher_cracks` (its glow
mask, so it must sit right of 250 in the same row: the same stone at 0.4 of its brightness — a faint self-light, so by night the
figure reads as pale stone, never a black shape — with the same crack pixels bright cyan 0x5ae6f0), 252 `watcher_smoke` (dark
neutral soot with lighter wisps rising).
`prewarm(webgl, camera)` pays every Watcher shader cost while the game loads, not on the frame of the first sighting: it compiles
the group against the real scene (`compileAsync(group, camera, scene)` when present, else `compile`) — the scene's lights are part
of every program's key, so it must run once every light exists — and makes every part (rings, smoke, lantern, core, lights, glow
sprites) draw ONCE in the next rendered frame, because ANGLE/D3D11 only finishes a program on its first draw: the group is shown as
a speck (scale WARM_SCALE 1e-6 at y WARM_Y −10 000) with frustum culling off until each part's `onAfterRender` has fired. `sync(null)`
keeps the speck meanwhile; a figure shown before then takes its place (its own first draw is the warm-up); afterwards the group is
hidden at full size with normal culling and stays so. `warmPending()` counts the parts still owing that draw. Never throws.
`dispose()` frees its geometries, materials, the glow texture and the crack-map clone (never the shared atlas).
main: ONE `Watcher()` for the session and a persistent `watcherWorld` (getBlock, isLoadedCell = hasChunkAtCell, groundHeight =
terrainHeightAt, isNaturalGround, hasEdit, `occupied` = a pig's or zombie's body intersects the cell); `refreshWatcherWorld()` sets
player, eye (player.y + getEyeHeight), look = `lookDirection(controls.yaw, controls.pitch)` (written in place), yaw, fov = `min(fov,
FOV)` (the eased camera FOV, never wider than the walking one: a spot found while sprinting at SPRINT_FOV stays on screen when the
sprint ends), viewFov = the eased camera FOV itself (what is on screen now, for the seen test), aspect = the camera's (`renderer.three.camera.aspect`, kept by `resize`), time, day and fogFar =
`fogRangeForRenderDistance(world.renderDistance).far` (the NORMAL fog: no sighting starts while the head is under water). `startLoading`
calls `watcher.clear()`, `setEnabled(save?.watcher !== false)`, `setLastNight(save?.watcherNight ?? null)` (absent — an older save —
means none; storage has already validated it) and stores `spawn` = world.findSpawn()'s (x, z); `buildSaveData` writes `watcher:
watcher.enabled` and `watcherNight: watcher.lastNight` (left out when null); autosave also fires when its `switchVersion` or its
`lastNight` changed since the last save (so a sighting is on disk soon even without a page-leave save); `quitToTitle` / `dispose`
clear it.
main creates the renderer with the others and calls `watcherRenderer.prewarm` after the campfire, falling-block and particle
renderers exist (after their prewarms): the campfire and explosion PointLights must be in the scene when it compiles.
`stepWatcher(dt)` runs after `stepZombies`: `update(dt, refreshWatcherWorld())`; `wisp` → 2 'smoke' particles (ash grey [0.11,
0.11, 0.12], spread 0.15, speed × 0.4) from its smoke wisp, 0.1–0.7 above its feet; `vanished` (not `unloaded`) → the puff: a column
of dark 'smoke' — 8 particles ([0.07, 0.07, 0.08], spread 0.4, speed × 1.2) every 0.45 from 0.3 above its feet up to WATCHER_HEIGHT —
plus 18 falling ash-grey 'dust' motes ([0.42, 0.42, 0.41]) at its middle, `audio.playWatcherVanish(max(0.4, 1 − d / 100))` (d = its distance from the player), then
`trace.writes` through `world.setBlock` in order. The CommandContext gets `watcher` and a `watcherWorld` getter (refreshes first);
`game.watcher` and the debug handle's `watcher` expose the instance. There is no pause-menu toggle (console `watcher on|off`).

## 41. Save slots — `src/storage.js` (PURE), the Worlds panel in `src/menus.js` and `index.html`, wiring in `src/main.js`

Up to SAVE_SLOTS (6) worlds side by side in the browser's localStorage. Each slot is ONE serializeSave document (§14) under its own
key; its `meta` carries the name and times, so the document alone is the truth. A small index key only caches what the Worlds screen
lists and is never trusted blindly. Every function takes the storage last (default `globalThis.localStorage`), never throws, and the
only clock is a `now` argument (default `Date.now()`).
```js
export const SAVE_SLOTS, MAX_WORLD_NAME_CHARS, STORAGE_QUOTA_ESTIMATE   // re-exported from config (6, 24, 5 × 1024 × 1024 characters)
export const LEGACY_SAVE_KEY = SAVE_KEY;          // 'caelancraft:v2:save', the single save of the versions before slots
export const SLOT_KEY_PREFIX = 'caelancraft:v2:slot:';   export function slotKey(n)  // 'caelancraft:v2:slot:1' … ':6'
export const SLOT_INDEX_KEY = 'caelancraft:v2:slots';    export const SLOT_INDEX_VERSION = 1;
export const MIGRATED_WORLD_NAME = 'My World';  export const COPY_SUFFIX = ' (copy)';
export function isSlot(n)                         // integer 1..SAVE_SLOTS
export function copyWorldName(name)               // "<name> (copy)", the name shortened first so the result keeps ≤ MAX_WORLD_NAME_CHARS
export function textHash(text)                    // 32-bit FNV-1a over the UTF-16 code units (uint32)
export function isQuotaError(err)                 // name QuotaExceededError | NS_ERROR_DOM_QUOTA_REACHED, or code 22 | 1014
export function listSlots(storage, { repair = true } = {})   // → SlotInfo[SAVE_SLOTS] in slot order
export function loadSlot(slot, storage)           // → SaveData|null; the result always has meta { name, createdAt, lastPlayed } (fallbacks below)
export function saveSlot(slot, data, storage)     // → SlotResult { ok, bytes } | { ok: false, reason: 'invalid'|'unavailable'|'quota'|'error' }
export function deleteSlot(slot, storage)         // → boolean: the slot is empty afterwards
export function renameSlot(slot, name, storage)   // → { ok, name, bytes } | { ok: false, reason: 'invalid'|'empty'|'damaged'|'quota'|'error'|… }
export function duplicateSlot(slot, storage, now) // → { ok, slot, name, bytes } | { ok: false, reason: …|'full' }
export function firstEmptySlot(storage)           // → 1..SAVE_SLOTS, 0 when none (a damaged slot is not empty)
export function migrateLegacySave(storage, now)   // → { status, slot?, reason?, legacyKept? } (§41.3)
export function storageUsage(slots)               // → { used: Σ slot bytes, quota: STORAGE_QUOTA_ESTIMATE, fraction: min(1, used / quota) }
/** SlotInfo = { slot, status: 'empty'|'world'|'damaged', name ('' unless world), seed (null unless world), createdAt, lastPlayed (ms, 0 =
 *   unknown), bytes (stored characters, 0 when empty), legacy (slot 1 still read from LEGACY_SAVE_KEY) } */
```

### 41.1 Slots, names and the index
1. A slot is EMPTY when its key is absent or ''; DAMAGED when it holds text that `deserializeSave` rejects (unparsable, wrong version,
   missing fields — e.g. a v1 cube save or a half-written blob); otherwise a WORLD. A damaged slot is never read, written over, renamed or
   copied: the Worlds panel offers only Delete. Names: `normalizeWorldName(raw, slot)` = `cleanWorldName(raw)` (§14) or, when that is
   empty, `defaultWorldName(slot)` "World N"; duplicates are allowed. A document without a name lists as "World N" — or MIGRATED_WORLD_NAME
   while it is still the legacy save (§41.3).
2. Index `SLOT_INDEX_KEY` = `{ "version": 1, "slots": [entry|null × SAVE_SLOTS] }`, entry `{ name, seed, createdAt, lastPlayed, bytes,
   hash }` or `{ damaged: true, bytes, hash }` (bytes = the slot text's length, hash = textHash of it). `listSlots` uses an entry ONLY when
   it is well-formed and both `bytes` and `hash` match the slot's current text; otherwise (missing / corrupt / foreign-version index, ghost
   entries for empty slots, a slot changed behind its back) the slot's document is parsed and the entry rebuilt. With `repair` the rebuilt
   index is written back when it differs (best effort; never when the index is absent and every slot empty); `repair: false` (?nosave)
   writes nothing. Writers refresh their slot's entry after a successful write (best effort: a failed index write only means a rebuild).
   **v0.9 (adjudicated, C's CONTRACT-ISSUE):** a cached `{ damaged: true }` entry is NOT trusted even when bytes and hash match — the
   slot is parsed again. A v0.8 tab lists a version-3 (Survival) world as damaged in the shared index, and trusting that would offer a
   good world for deletion only. (Cosmetic leftover: such a world's "· Survival" label is lost from the index until it is saved again.)

### 41.2 Writing (never lose the previous save)
`saveSlot` serialises first (a TypeError → 'invalid', nothing touched), writes the whole document with ONE `setItem` (Web Storage leaves
a key untouched when setItem throws, so a full storage keeps the old save byte for byte), then reads it back: a write that threw but
changed the key anyway, or stuck as something else, is put back to the previous text (or removed when there was none) and reported
('quota' for a quota error, else 'error'). No temporary second copy is written — it would need room for the save twice. `renameSlot`
rewrites the document with `meta.name` replaced (content and times unchanged); `duplicateSlot` writes into `firstEmptySlot` with `meta
{ name: copyWorldName(src name), createdAt: now, lastPlayed: src lastPlayed ?? now }` and writes nothing when there is no empty slot
('full') or no room ('quota').

### 41.3 Moving the old single save (`migrateLegacySave`; main calls it at boot unless ?nosave)
1. Nothing under LEGACY_SAVE_KEY → 'none'. A slot already holding the same world (`meta` aside; or the identical text) → an earlier run
   copied it but could not remove the legacy key: remove it now → 'migrated' (no second copy).
2. Target = slot 1 when its key is empty, else the first empty slot; none → 'no-room' (legacy key untouched). A loadable save is written
   with `meta` (its own fields, else name MIGRATED_WORLD_NAME "My World" and both times `now`); a damaged one VERBATIM (it then lists as
   damaged; the player decides).
3. The legacy key is removed ONLY after the copy was written and read back identical → 'migrated' (`legacyKept: true` when the removal
   failed; finished on the next boot by 1). A copy that throws → 'deferred' (`reason`; any partial copy removed, legacy untouched); one
   that reads back different → 'failed' ('verify'; the copy removed, legacy untouched).
4. While slot 1's own key is empty and the legacy key holds text, SLOT 1 IS THE LEGACY SAVE: listSlots / loadSlot / saveSlot / renameSlot /
   deleteSlot / duplicateSlot read and write LEGACY_SAVE_KEY in place (`SlotInfo.legacy = true`). That keeps a save too big to exist twice
   (e.g. > half the quota: 'deferred' with 'quota') playable and saveable; the move is retried on every boot. A legacy save that appears
   after the move (an old tab saving on close) becomes another world in the first empty slot, never merged into slot 1.

### 41.4 The Worlds panel (title screen: `index.html`, `menus.js`, `styles.css`)
`#title-screen` = logo, splash, `.title-main` (flex row, wraps) = `#worlds-panel.worlds-panel` (min(640px, 100%) wide: `.worlds-head`
"Worlds" + `#worlds-count` "N of 6 slots used", `ol#worlds-list`, `.usage-row` "Storage" + `#usage-bar` (role meter) / `#usage-fill`
(class `warn` from 75 %, `full` from 90 %) + `#usage-text` usageLabel "1.1 MB of ~5 MB (23%)", `#worlds-message` status line, red with
class `error`) beside `#title-controls`; at 1280×720 both fit side by side without scrolling, narrower windows stack them and scroll.
Rows `li.world-slot.<status>[.latest][.editing][data-slot]` (min-height 50px; `.latest` = latestSlot, the most recently played):
`.slot-num`, `.slot-body` (`.slot-name`: the name / "Empty" / "Damaged world"; `.slot-detail`: slotDetailText "Seed 77 · played
yesterday · 1.1 MB", "Can't be read · 2 KB", "No world yet"; formatLastPlayed: just now / N minutes|hours ago / yesterday / N days|
months|years ago, '' when unknown) and `.slot-actions`: world → Play, Rename, Duplicate (only while an empty slot exists), Delete;
damaged → Delete; empty → New World. Under `readOnly` Rename / Duplicate / Delete are disabled. Buttons carry `data-action` /
`data-slot` (one delegated listener) and an aria-label naming the world.
New World and Rename replace the row's text and buttons with an inline `form.slot-form`: `#world-name-input` (maxlength 24; New World
prefilled "World N", Rename the current name; focused and selected), for New World also `#seed-input` (placeholder "random", prefilled
from ?seed), then Create / Save (submit, Enter) and Cancel (Esc). One form at a time. Delete opens `#confirm-dialog` (z 60, role
alertdialog): deleteConfirmText — `Delete “<name>”?` / `Slot N · seed S. This cannot be undone.` (damaged: `Delete the damaged world
in slot N?`) — with Delete (`#confirm-yes`, fires onDeleteWorld) and Cancel (`#confirm-no`, focused; Esc and a click on the backdrop
cancel and give the focus back; Tab stays on the two buttons). Keyboard: every control is a real button / input; ArrowUp / ArrowDown
move between rows (same button position), ArrowLeft / ArrowRight along a row; showTitle focuses `focusSlot`'s row, else the last played
world's Play, else the first New World. `#splash-text` has `pointer-events: none` (it can sit over the panel in narrow windows).

## 42. Survival mode (v0.9) — the switch, generation 2, the save fields, and Creative's guarantees

Design and rationale: `docs/DESIGN-survival.md` (its §13 Decisions and §14 Handbook win over its earlier text); this section and
§43–§49 are the normative summary as merged. **Creative and every existing world keep working exactly as before.**
- **SV / S.** "In Survival" (SV) = `survival.inSurvival` (mode `'survival'`, dead or alive): it drives every UI and input branch.
  "Survival active" (S) = `survival.active` (in Survival and not dead): it gates the vitals, the craft lanes, fire spots and fuel,
  regrowth, spoilage and pig repopulation. Nothing survival steps otherwise, and nothing catches up on a backlog (pitfall 28).
  The stat stored as `satiation` is shown as **Nourishment** everywhere; the key stays `satiation`.
- **The switch.** Pause menu `[ Creative | Survival ]` (`#btn-mode`, §48), console `mode creative|survival` (console only, §49),
  URL `?mode=` (first world only, with `?autoplay`/`?smoke`, §49). Every one calls main's `requestMode(mode)`, which only sets
  `pendingModeSwitch`; main applies it at the top of the next frame while PLAYING, PAUSED, CONSOLE or EDITOR (an open console or
  editor is closed first). Never switched inside a command, a hook or a step (pitfall 31). The death screen is modal: no switch
  while dead.
- **Creative → Survival** (`survival.setMode`): a generation-1 world is upgraded first (below). Without a survival state one begins
  (§45 new values; an empty pack plus the Handbook in slot 8, §43) with the chat line `SURVIVAL_INTRO` (+ `HANDBOOK_INTRO` when the
  Handbook was given; in DESERT, SNOWY, MOUNTAINS, SNOWY_PEAKS also "This land is harsh: green land lies near q Q, r R." from
  `world.findSurvivalSpawn()`); with one, it comes back exactly as left. Flight off, `fallGrace` set (`landSpeed` zeroed), the HUD swaps
  to the hex hotbar and the vitals, Undo is disabled (§33.8).
  **Survival → Creative**: the survival state (vitals, pack, wear, fire spots and fuel, Sleeping Hide) is frozen and kept in the save;
  the creative `hotbar` comes back unchanged. No item ever moves between the two inventories (pitfall 30). The world is shared.
- **Generation 2** (§47). `gen` save field: absent = 1 (today's terrain, byte for byte); `gen: 2` adds the survival resources. New
  worlds: the New World form's checkbox "Survival resources (wild plants, ponds, copper and tin)", checked by default → GEN_LATEST
  (2), unchecked → 1 (`main.loadingGen`). Old worlds stay generation 1 until first switched to Survival: the pause menu asks
  (`menus.confirm(UPGRADE_CONFIRM)`: "Bring survival resources into this world?" / "Copper, tin, clay, wild plants, ponds and new
  trees will appear wherever the land is untouched — near your builds too. This cannot be undone." / `Bring them` / `Cancel`; after the
  await it continues only if still PAUSED in the same world); the console does not ask. The upgrade, exactly:
  `data = buildSaveData(); data.gen = GEN_LATEST; data.mode = 'survival'; data.player.flying = false; if (!nosave) saveSlot(currentSlot,
  data); startLoading(world.seed, data)` — gen and mode reach the store together — then the chat line "Survival resources have come
  to this world." A save with `mode: 'survival'` and no `gen ≥ 2` (hand-edited) loads in Creative with the warning
  `mode: survival needs generation 2; loaded in Creative` (storage.js and `main.loadingMode` both apply it).
- **Save fields** (§14), after `watcherNight`, before `meta`, in this order: `gen` (integer ≥ 2 only), `mode` (only once the world has a
  survival state), `survival` (§45 vitals + `pack`, `wear` + `fires`, §46), `containers` (§43, only when non-empty). **Version 3**
  exactly when `gen ≥ 2` or `survival` is present, else 2 — so an older client shows such a slot as damaged (never overwritten)
  instead of silently regenerating gen-1 terrain under gen-2 edits, and **a Creative world that never entered Survival serialises
  byte-identically to before, still version 2** (tested). `main.survivalSaveFields({ gen, survival, pack, fireSlots, containers })`
  builds the four fields.

## 43. Items, the pack and containers — `src/items.js`, `src/inventory.js`, `src/containers.js` (PURE)

```js
// items.js (imports blocks only; deep-frozen; Map lookups, so '__proto__' is just unknown; throws at import on a duplicate key or name)
export const TIER /* {HAND 0, STONE 1, FLINT 2, COPPER 3, BRONZE 4, IRON 5, STEEL 6} */, TIER_NAMES, TIER_SPEED /* [1,1.5,2,2.6,3.4,4.5,6] */,
  TOOL_TYPES, WEAR_SLOT_NAMES /* ['head','body','feet'] */, TAGS /* log, planks, fuel (coal then charcoal), tinder, knapstone, sand */;
export const ITEMS, ITEM_KEYS   // display order: tools, materials, food, heal, wear, then blocks in PICKER_ORDER order
export function getItem(key), isItemKey(key), stackSize(key) /* 0 unknown */, maxDurability(key) /* 0 none */, itemForBlock(id),
  blockForItem(key) /* −1 */, hasTag(key, tag), itemName(key) /* '?' */, resolveItem(token) /* {key}|{error} */
/** ItemDef = { key, name, kind: 'block'|'material'|'food'|'heal'|'wear'|'tool', stack, block?, tool?: {type, tier, durability, power},
 *   food?: {satiation, hydration, sick (fraction), useS, temp?, returns?, spoilS?}, heal?: {hp, rate, useS},
 *   wear?: {slot, insulation, sunShade}, tags? }   ItemStack = { k, n ≥ 1, d? (durability left; absent = new) } */
```
Every placeable block except WATER has a block item (key = block name, stack 64); `honeyberry_bush` / `prickly_pear` place their
picked (`_BARE`) block, and both variants map back to the ripe item (a transplant must regrow). LOOSE_STONES, FALLEN_BRANCHES,
FIRE_PIT and REMAINS have no item. Tools have stack 1 and never stack; two stacks merge with the same `k`, no `d`, within the stack
size. The full registry is DESIGN-survival §5.1 (tested item by item).
**The Pack** (`new Pack()`): `slots` (PACK_SLOTS 27; 0–8 the hotbar = HOTBAR_SIZE) and `wear` (3: head, body, feet); `version` bumps on
every change (`touch()` after an in-place change). `add(stack)` merges into same-key stacks 0 → 26, then fills empties 0 → 26, returns
the overflow (main: "Pack full: 2 Rock left behind", once per 2 s); `addAll`. PackOps (what crafting.js and the actions use): `count,
countTag, take / takeTag` (from slot 26 back to 0; tag members in TAGS order; return the count taken), `canGive(list)` (all together,
nothing changes), `give(key, n) → leftover count`, `hasTool(type, minTier)`, `useTool(type, minTier) → {key, broke}|null` (the lowest
qualifying tier, ties to the least durability left, then the higher slot). Also `toolAt(i), consume(i, n), damage(i, n) → {key,
broke}|null` (breaks at 0), `equip(i)` (swap with the worn item of its slot), `unequip(w)`, `insulation()` (Σ I), `sunShade()` (max),
`dumpAll()` (death; v0.9 §14: `KEEP_ON_DEATH` items stay), `spoil(dt, random)`, `hotbarSlotOf(key)` (middle mouse), `export() → {pack,
wear}`, `load(json) → warnings`. Pure `slotClick(session, area, index, button, shift) → {changed, container, discarded[, refused]}`
implements every pack-screen rule (left: pick up / put / merge / swap; right: half / one; wear slots take only their wear items; shift
quick-moves pack → open container, else hotbar ↔ rosette, container → pack, wear → pack; `'discard'` destroys the cursor stack — never
the Handbook, which comes back with `refused` "The handbook stays with you."), and `returnCursor(session)` (closing with a cursor
stack). main calls `containers.touch()` when `container` is true. **Spoilage** is stateless: while S, once a second, each perishable
stack loses 1 with probability `min(1, n·dt / food.spoilS)`, in the pack (chat "1 Raw Pork went bad.", once per 2 s) and in every
basket / belongings entry whose chunk is loaded.
**Containers** (`new Containers()`, keys `"q,y,r"`): kinds `basket` (WICKER_BASKET, BASKET_SLOTS 18) and `remains` ("Your Belongings",
REMAINS, ≤ REMAINS_SLOTS 30). `onBlockChange` (main forwards every write, in every mode): a cell becoming WICKER_BASKET gets an empty
entry (at most MAX_CONTAINERS 1024; beyond it the basket has no storage: hint `Basket · too many containers in this world`); a cell
with an entry changing to anything else releases its stacks — into the pack when the player broke it in Survival (main's
`releaseToPack`), otherwise lost. `ensureBasket, hasItems, contents, takeAll(q, y, r, pack) → {moved, empty}` (overflow stays inside;
main writes AIR when empty), `addRemains(q, y, r, stacks)` (a death always gets its entry, beyond the cap), `spoil(dt, random,
isLoadedCell)`, `size, version, touch, export()` (keys sorted; empty baskets too) / `load(json) → warnings`. Saved as `containers`,
validated against the repaired `edits` like runes (§14).
**The Survival Handbook** (DESIGN-survival §14; `src/handbook.js`, PURE): item `handbook` (non-block, stack 1, never spoils, no
recipe makes or takes it). API: `HANDBOOK_KEY 'handbook'`, `HANDBOOK_CHAT_LINE` (main's `HANDBOOK_INTRO`, the §1.2 sentence "Your
handbook is in the last hotbar slot — hold it and press R to read."), `buildChapters() → Chapter[]` (cached; ten chapters `{ id, title,
short, icon, pages: Block[][] }` of hand-written prose and tables GENERATED from RECIPES, ITEMS, BLOCK_RULES, the climate and vitals
tables — each table names its `source` and its rows' `keys`, so a test can walk it against the data; `TABLE_ROWS_PER_PAGE 10` splits
long ones), `chapterIds()`, `ensureHandbook(pack, preferSlot = 8) → boolean` (gives one when the pack — slots and wear — has none:
`preferSlot` if empty, else the last empty slot; false when it already has one or is full), plus the pure formatters (`fmtNum,
fmtTemp, fmtDuration, inlineParts, plainText, describeDrops, …`). **Rules:** when a survival state begins, and again on waking,
`ensureHandbook(pack)`; death never puts it into Your Belongings (`inventory.KEEP_ON_DEATH = ['handbook']`: `dumpAll` leaves it in its
slot); the discard hex and every move into a container refuse it (`slotClick` changes nothing and reports `refused` =
`inventory.KEEP_REFUSED` "The handbook stays with you."; `returnCursor` never leaves it behind); the console cannot mint a second copy
(§26.4, main's `consolePackAdd`) and `pack clear` gives it back. **Reading** (§44 `interactKind` priority 10, after every other R
target, before today's barrel and rune behaviour: `{ kind: 'read', hint: HINT.read }` = `Handbook · R: read`; `useActionOf` →
`{ kind: 'read', needS: 0 }` so RMB opens it at once): R or RMB with it selected, or `onRead` in the pack screen, open the field book
(§48, §49); the Guide is the same text from the menus.

## 44. Harvesting — `src/harvest.js` and `src/survivalControl.js` (PURE)

```js
// harvest.js
export const BLOCK_RULES                      // index = block id: { h (s by hand), tool, tier (0 = hands allowed), drops: DropGroup[] } | null
export function ruleFor(id), canHarvest(id, tool), breakSeconds(id, tool, underwater) /* Infinity = cannot */, harvestHint(id)
export function rollDrops(id, tool, { natural, knifeInPack }, random) → ItemStack[]   // aggregated by key; [] when it cannot
export const PICKABLE; export function isPickable(id), pick(id, ctx, random) → { to, drops } | null
export function tap(id, selectedKey, knifeInPack) → { gives: 'pot_sap', takes: 'clay_pot', wears: 'knife' } | null
export class Tapped { canTap(key, day), mark(key, day), clear() }          // once per birch cell per game day; not saved
export class Regrowth { track, untrack, onBlockChange, loadFromEdits(edits), step(dt, random, isLoadedCell) → [{q,y,r,id}], clear, size }
export const MOB_DROPS; export function rollMobDrops(kind, random), toolPower(tool) /* hand 1 */, ripeOf(id)
```
`breakSeconds = max(0.05, h / speed) × (underwater ? 2.5 : 1)`, `speed = TIER_SPEED[tier]` with the rule's tool type, else 1;
a rule with `tier > 0` needs that tool type of at least that tier (else Infinity: hint `Iron Ore · needs a bronze pick or better`).
Drops are groups; each group gives the first branch whose condition holds (tool type, or `knifeInPack` = a knife ≥ 2 anywhere in the
pack); `natural` items only from a cell that had **no edit before the break** — main computes `!world.hasEdit(q, y, r)` BEFORE
writing AIR (the write records an edit; checking after would make every natural drop, and all flint, impossible). The table is
DESIGN-survival §6.3 (every block id has an entry; AIR, BEDROCK and the water family are null = unbreakable). Highlights: there is no
stone pick (rock needs a flint pick, tier 2); leaves give a stick and themselves only to an axe; loose stones rock 1–2 + flint p 0.5
natural; STONE rock 2 + flint p 0.05 natural; obsidian and gems need only a flint pick; tin a copper pick; iron and gold a bronze pick.
Regrowth tracks picked bushes and pears (≤ MAX_REGROW_TRACKED 4096); while S main calls `step(1, …)` once a second and writes each
returned cell's ripe id LAZILY (`world.setBlock(q, y, r, id, true)`, which prunes a wild bush's edit) when the cell still holds the
picked id. Broken plants and litter never come back.
**survivalControl.js** (main's input state machines and choices, unit-tested instead of hand-written into main):
`DigState.step(dt, target, held, need, handKey) → { progress, done, tick }` (accumulates on the same cell + id + hand; any change,
a release or `reset()` resets; ticks on the first frame and every DIG_TICK_S, every 0.5 s for a block it cannot break; `done` stays
until `reset()`, which main calls after a break and when a modal opens); `UseState.step(dt, action, held) → { progress, done }` (one
use per `needS`, the next after USE_REPEAT_GAP_S; `repeat: false` once per hold); `handKeyOf(selected, stack)` (durability left
out: wear does not reset a dig, a tool breaking does); `useActionOf(stack)` (RMB: eat / drink (food that returns a pot) / bandage /
wear (needS 0, once) / place); `placeRefusal(getBlock, id, q, y, r)` (`needs solid ground` for a pop-off block over a non-solid
cell); `strikeKind(mob, tool)` (bare hands only shove a pig); `chooseBelongingsCell` (§45); `buildPackView` (§48); `HINT`,
`STATION_OF_BLOCK`, `STATION_TABS`, `KNIFE_TIER` 2, `waterHint`.
**`interactKind(ctx)`** — R in Survival, the first that applies: 1 CAMPFIRE → `fire_put` (a skewer food or centre pot selected and a
free spot of that kind) / `fire_feed` (a stick or `#log`) / `fire_take` / `fire_hint`; 2 FIRE_PIT → `pit_take` / `pit_relight`
(drill, 1 `#tinder`, 3 sticks; held RELIGHT_HOLD_S) / `pit_hint`; 3 ripe bush, prickly pear, loose stones, fallen branches → `pick`
(whatever is in the hand); 4 BIRCH_LOG → `tap` (empty clay pot selected, knife ≥ 2 in the pack, not tapped today; held TAP_HOLD_S) /
`tap_hint`; 5 WICKER_BASKET → `basket`, REMAINS → `belongings`; 6 SLEEPING_HIDE → `hide`; 7 a workplace → `station`; 8 water →
`fill` (empty clay pot selected) / `drink` (anything else in hand); 9 head under water → `drink_here`; 10 (§14) the Handbook
selected → `read`; null → today's barrel and rune behaviour. **Adjudicated (B's CONTRACT-ISSUE):** where DESIGN-survival §9.4
lists cases 1–7 before water and §4.2 says R uses `waterHit` whenever its water is nearer than `hit`, §4.2 wins: water in front of a
block takes the R (they differ only for a block seen through water). ctx = `{ hit, waterHit, headInWater, selectedKey, pack,
fireView (cooking FireSlots.view), fireSpotKind (main: cooking.isSkewerFood → 'skewer', isCentrePot → 'centre'), tappedToday,
salty (climate.isSaltyBiome of the column) }`.

## 45. The body — `src/vitals.js`, `src/climate.js`, `src/survival.js` (PURE); physics, bodies, pigs and zombies additions

Every number is DESIGN-survival §2–§3, by name: `vitals.RATES`, `climate.*` constants, `config` (STAT_MAX, BREATH_MAX_S 20,
BREATH_REFILL_PER_S 5, BODY_TEMP_NORMAL 37, BODY_TEMP_MIN 25 / MAX 45, SICK_MAX_S 600, HEAL_MAX 50, FALL_SAFE_SPEED 13.5, FALL_DAMAGE_K
0.1, CRUSH_DAMAGE_PER_CELL 6, ZOMBIE_DAMAGE 8, FIRE_BURN_DAMAGE 4). Rates are per real second.
- **Stats** health 0–100, satiation ("Nourishment") 0–100, hydration 0–100, temp 25–45 °C, breath 0–20 s, wet 0–1, sick 0–600 s,
  heal (pending bandage HP) 0–50. New: 100 / 80 / 80 / 37 / 20. **Waking**: health 60, satiation and hydration max(current, 50),
  37 °C, full breath, dry, well, nothing pending.
- **Drain** satiation 0.0556 × activity × coldFactor × sickFactor, hydration 0.0833 × activity × heatFactor × sickFactor; activity is
  the largest of still 1, walking 1.4, breaking 1.8, swimming 2.2, sprinting 2.5. heatFactor and coldFactor are the only temperature
  terms. **Regeneration** 0.12 HP/s (× 2 still ≥ 3 s within 4 of a burning campfire) needs satiation ≥ 50, hydration ≥ 50, body
  35.5–38.5, not sick, breath > 0; each HP costs 0.25 satiation. Bandages pay out queued HP at 1.5 / 2.5 HP/s whatever else holds.
- **`statusOf(v, {headInWater, buried}) → { canSprint, moveFactor (≥ 0.6), regen, labels }`** (§2.3 table). Of each pair only the
  worse label shows (Starving replaces Hungry, Parched replaces Thirsty) — D's choice, kept. **Adjudicated:** Hypothermic (< 31 °C)
  also forbids sprinting (the milder Cold and Freezing rows do; the table omitted it). Main applies `input.sprint &&= canSprint` and
  `input.speedFactor = moveFactor` while S (1 otherwise).
- **Damage over time** starve 0.35, thirst 0.7, cold 0.4 (Freezing) / 1.5 (Hypothermic), heat 0.4 (Overheating) / 1.5
  (Heatstroke), drown / buried 8 at breath 0, sick 0.15 (never below 10 HP: sickness never kills alone).
- **Climate** (`climate.js`): `baseTemperature(biome, T) = 12 + 22·T` (DESERT +4, SNOWY −4, OCEAN/BEACH halfway to 16);
  `airTemperature` adds the diurnal swing A[biome]·cos(2π(t − 14:00)) and −0.25 °C per cell above y 64, except underground (the daily
  mean); `feltTemperature(ClimateInput) → {air, felt}` adds sun (open sky, by day, × (1 − sunShade)), shelter +3 (no open sky and air
  < 10), heat sources (Σ heat·(1 − d/radius)², ≤ 30, from the chest = feet + CHEST_HEIGHT; campfire 20/6 measured to fire.y + 0.3,
  kiln 12/4, bloomery 16/4, forge 22/5 while their lane runs a job), insulation I·(1 − 0.6w)·(1 − 0.5·wet), exertion (+1/+2/+2/+4),
  ground −2 on snow or ice, −6·wet; in water `waterTemp + 0.25·I + 2`. `bodyTarget(felt, inWater)`; body temp moves with τ 120 s away
  from 37, 40 s back, × 0.3 in water. `isSaltyBiome(biome)`: OCEAN or BEACH water is salt, all other water fresh.
- **`Survival`** (`survival.js`): `mode, hasState, switchVersion, vitals, spawn ([q,y,r] Sleeping Hide | null), deaths, dead (cause |
  null), fallGrace, felt, air`; getters `inSurvival, active, status`; `setMode(mode) → changed` (only main's switch calls it; begins a
  state on first entry; refused while dead), `begin()`, `step(dt, SurvivalEnv) → { damage, causes, died, felt, air, fall, pulse }`
  (order: the fall — `landSpeed` consumed, no damage under fallGrace, any landing clears it; breath; wet; felt and body temperature;
  drains, regeneration, bandages; damage over time; death by the cause that dealt the most), `damage(amount, cause) → killed`,
  `eat(key, random) → { ok, message?, returns? }`, `drink(salty, random) → line` (fresh +8 with 1 % Sick; salt −4, "Salt water only
  makes you thirstier." at most once per 5 s), `bandage(key)`, `respawn()`, `setVital(name, v)`, `restoreVitals()`, `export()` (§14
  canonical order, 3 dp, `dead` only while dead) / `import(json)` (null → no state). `DEATH_TITLES` / `deathTitle(cause)`,
  `BELONGINGS_KEPT`, `BELONGINGS_LOST`. SurvivalEnv = `{ player, softFactor, breaking, moving?, still?, buried, climate: {biome, climateT,
  openSky, underground, groundChill}, heat, nearFire, insulation, sunShade, time, random }`.
- **Damage sources** (cause keys, `vitals.DAMAGE_CAUSES`): `fall` `0.1·(v² − 13.5²)` × the softest landing factor under the feet
  (SNOW_BLOCK 0.4, leaves and HAY_BALE 0.6, wool 0.7, SLEEPING_HIDE 0.9) — 3 cells safe, 21 survivable from full health, 22 kills;
  water cushions; `drown`, `buried` (findFreeY null and the eye cell solid); `crush` 6 × cells lifted by unstickPlayer (not on a
  teleport frame, under fallGrace or on top of a blast / log hit); `fire` 4 per scorch (≤ 1 / 0.5 s); `zombie` 8 per strike; `blast` /
  `log` `knockDamage(|Δv|) = 6·max(0, |Δv| − 5)`; `blackhole` and `void` (feet below y −32): death, belongings lost; `starve`,
  `thirst`, `cold`, `heat`, `sick`; `command` (`vitals health 0`). Death titles: DESIGN-survival §2.5 table.
- **Physics** (§12): `stepPlayer` sets `p.landSpeed = 0` on entry (after its dt guard) and records the fastest downward impact before
  zeroing vy (in every mode; standing records one substep of gravity, ≈ 0.47 m/s — harmless, and it lets "any landing clears
  fallGrace" work). **Consume semantics:** `survival.step` reads `landSpeed` and sets it to 0, so a stale value is never applied twice;
  main zeroes it whenever it sets fallGrace (switching to Survival, loading it, every `game.teleport`). `input.speedFactor` (0..1,
  absent 1) scales the horizontal target speed on foot, never in flight. `bodies.standOn` records `landSpeed` too (landing on a mob
  counts).
- **Pigs** (§30): `spawn` sets `health = PIG_HEALTH` 5 (not saved: pigs heal on reload); `wound(pig, power, fromX, fromZ) → 'hit' |
  'dead' | null` (null during `hurt`); `pruneFar(x, z, isLoadedCell, minDist)`; `spawnNatural(…, surfaces = [GRASS_BLOCK])`. Creative
  only ever calls `hit`, so pigs never die there. **Zombies** (§39): `hit(zb, fromX, fromZ, power = 1)`; mode-agnostic — main applies
  the damage.

## 46. Making and fire — `src/crafting.js`, `src/cooking.js` (PURE)

```js
// crafting.js (PackOps only: no inventory import)
export const STATION_IDS /* hand, stump, kiln, bloomery, forge */, STATION_BLOCKS, STATION_NAMES, RECIPES /* 89 */, TAG_LABELS;
export function stationOfBlock(id), findStations(getBlock, q, y, r) → { hand: true, stump?: [q,y,r], kiln?, bloomery?, forge? },
  getRecipe(id), recipeName(rec), inputLabel(inp), toolLabel(type, tier), listRecipes(pack, stations, { station?, queue? }) → RecipeView[]
export class CraftQueue { enqueue(recipeId, times, pack, stations) → { ok, message, queued }, step(dt, pack, stationCheck, playerCell)
  → { done, failed, broke, lost, messages }, cancel(lane, i), lanes(), jobs(), chipText(), clear(), size, version }
```
Recipes: DESIGN-survival §7.3 (37 hand, 12 stump, 21 kiln, 4 bloomery, 15 forge; ids unique; a packing recipe uses 3, 6, 7 or 12 of an
input, never 4 or 9 — tested). A workplace is **near** within hex distance STATION_RANGE 3 of the feet cell and |dy| ≤ 2
(`findStations`, refreshed every CLIMATE_SAMPLE_S and when the pack screen opens). **Lanes:** one per station; each lane's head job
runs alongside the others. Queueing needs the station near (the job remembers its cell), room under MAX_CRAFT_JOBS 8 across all
lanes, the tools, and the inputs of every queued job in every lane plus this one (exact keys first, then tags in TAGS order); ×5
queues as many as fit. A head job runs while its station cell still holds the station and lies within STATION_WORK_RANGE 16 of the
feet column at any height (else it waits, "Kiln too far"); hand jobs never wait for range; a vanished station fails the job ("Couldn't
make Charcoal: the Kiln is gone."). Completion is atomic: wait while the outputs do not fit ("Pack full"), fail on missing inputs or
tools, else take the inputs (the queue-wide allocation), wear each tool once, give the outputs. Inputs are only consumed on
completion, so lanes are never saved or refunded (a reload, a death or a switch to Creative drops them). **Adjudicated (C's
CONTRACT-ISSUE):** `step`'s third argument is a block reader `stationCheck(q, y, r) → id` (main passes `world.peekBlock`: UNLOADED or
a non-integer reads as not loaded → the job waits) — a findStations result only covers 3 cells, not the 16-cell work range.
**Adjudicated (B's and C's CONTRACT-ISSUE): `lanes()` → `[{ station, label, jobs: [{ id, name, progress 0..1, secondsLeft, waiting:
boolean, reason }] }]`** (busy lanes only, station order) is the one shape; `survivalControl.buildPackView` maps it to the screen's
`{ name, progress, waiting }`. `chipText()` = the HUD job chip (`Kiln · Copper Ingot 12 s`, `+2` with two more lanes busy).
```js
// cooking.js
export const FIRE_TRANSFORMS /* key → { to, seconds, spot: 'skewer'|'centre' } */, SKEWER_FOODS, CENTRE_POTS, SKEWER_ANGLES, SKEWER_SPOTS 6, EMBERS_SPOT 6;
export function isSkewerFood(k), isCentrePot(k), spotKind(i), spotAccepts(i, k), hasCooked(k), fuelSeconds(k), formatFuel(s),
  fireKey(q, y, r), parseCellKey(key), normalizeFiresJSON(raw, { prefix?, cellOk? }), fireHint(view)
export class FireSlots { put(q, y, r, key, facing) → spot | −1, canPut, takeReady(q, y, r, give?) → ItemStack[], hasItems, light(q, y, r, fuel),
  addFuel(q, y, r, s) → 'ok'|'full'|'untracked', fuel(q, y, r), step(dt, isBurning, isLoaded) → { burntOut, cooking },
  onBlockChange(q, y, r, prev, next) → ItemStack[], view(q, y, r) → { spots: ({k, progress, secondsLeft, next}|null)[7], fuel } | null,
  export(), load(json), clear(), size, version }
```
Every CAMPFIRE has FIRE_SPOTS 7 spots: 0–5 green-wood skewers at the corner stones (angle 60k − 90°), one skewer food each; 6 the
embers, one pot. `put` takes ONE item to the free spot of its kind nearest `facing` (main: the angle from the fire toward the player).
Each spot has its own timer and transforms chain (raw pork → roast 20 s → charred 40 s more). `takeReady` takes every spot that has
finished at least one transform, or everything when none has; with `give` (main: `pack.add(...) === null`) what does not fit stays.
**Fuel (Survival-placed fires only):** a campfire placed while in Survival gets `light(…, CAMPFIRE_FUEL_START_S 300)`; feeding adds
FUEL_STICK_S 40 / FUEL_LOG_S 300 up to CAMPFIRE_FUEL_MAX_S 1200 (`full` → hint `The fire is fully fed`); fuel counts down only while S
and the chunk is loaded; at 0 `step` reports it in `burntOut` ONCE and main writes FIRE_PIT (a plain `world.setBlock`). A fire pit is a
meshed cutout block: no heat, light, smoke or safe zone; its spots stay, frozen (R takes them). Relighting (hold R RELIGHT_HOLD_S 3 on
an empty pit with a fire drill, 1 `#tinder`, 3 sticks; costs the drill 1 wear) writes CAMPFIRE with `playerSetBlock` and
`light(…, 300)`. **Fires with no fuel entry** (placed in Creative, or from before v0.9) burn forever (`untracked` → `This fire needs
no fuel`); a Survival visit never turns them into pits. `onBlockChange` keeps the spots across CAMPFIRE ↔ FIRE_PIT (a burn-out drops
the fuel entry; an entry left with nothing is forgotten) and releases them on any other change — into the pack when the player broke it
in Survival, else lost. Runtime cap MAX_FIRE_SLOTS 256 (a 257th new fire burns forever, as a reload would). **Adjudicated (C's
CONTRACT-ISSUE):** a saved spot is kept when its item can be on that kind of spot — anything put there or anything the fire makes of it
(`spotAccepts`, the transform chain), not only keys with a FIRE_TRANSFORMS entry, which would throw every finished item away on reload.

## 47. World generation 2 — blocks 76–94, tiles 77–104, ores, ponds, flora, species, pop-off

- **Blocks** (§5): COPPER_ORE 76, TIN_ORE 77, HONEYBERRY_BUSH 78, HONEYBERRY_BUSH_BARE 79 (not placeable), TUSSOCK 80, CATTAILS 81,
  TUBER_PLANT 82, PRICKLY_PEAR 83, PRICKLY_PEAR_BARE 84 (not placeable), WORK_STUMP 85, KILN 86, BLOOMERY 87, FORGE 88, WICKER_BASKET 89,
  SLEEPING_HIDE 90, REMAINS 91 ("Your Belongings"), LOOSE_STONES 92, FALLEN_BRANCHES 93, FIRE_PIT 94 ("Cold Fire Pit") — the last four not
  placeable; **BLOCK_COUNT 95**. PLANT = solid false, opaque false, LAYER_CUTOUT, cullSame false, sound leaves unless stated; REMAINS,
  litter and FIRE_PIT use the same flags. They are walk-through, not load-bearing, NOT replaceable (break first) and NOT fall-through.
  Predicates: `isPlant` (78–84, `PLANT_IDS`), `isLitter`, `isPopOff` (CAMPFIRE, FIRE_PIT, plants, litter — `POP_OFF_IDS`, 11 ids),
  `isStation` (the four workplaces), `isContainerBlock` (WICKER_BASKET, REMAINS). PICKER_ORDER has 80 entries (copper and tin ore after
  DIAMOND_ORE; the five plants after PUMPKIN; the six workplaces and containers before CAMPFIRE; RUNE_BLOCK, WATER last).
- **Tiles** 77–104 (`TILE_IDS` 115); original procedural art (tiles.js comments are normative). Short blocks (TUSSOCK, TUBER_PLANT,
  LOOSE_STONES, FALLEN_BRANCHES, FIRE_PIT) have the all-clear `PLANT_TOP_CLEAR` (101) on top and bottom, so `averageColor` of their top is
  [0, 0, 0]: **particles.blockParticleColor falls back to the side tile when the top has no opaque texel** (v0.9 fix; dust is never black).
- **`createWorldGen(seed, { gen = 1 })`** (§8): anything not an integer ≥ 1 is 1, above GEN_LATEST clamped. Generation 1 is byte-identical
  to before (pinned checksums). Generation 2, in order inside `generateChunk`: `ORE_TABLE_GEN2` rows appended after ORE_TABLE (oi 6–8;
  copper y 30–80, tin y 20–64, clay y 52–62 replacing sand, gravel and dirt; every gen-1 vein unchanged); hex **ponds** (POND_CELL 20
  jittered grid; a centre in PLAINS / FOREST / SNOWY with every column within 2 at height ≥ H, those biomes, no trunk within 2: WATER
  (SNOWY: ICE) at y = H within distance 1, CLAY under it, cattails / loose stones on part of the rim); **trees** through `treeTrunkAt(kq,
  kr) → { tq, tr, height, trunk, biome, species } | null` (exactly the gen-1 acceptance test; never consults ponds) with species SNOWY →
  spruce, FOREST → birch when `((hsh >>> 24) & 3) === 0`, else oak; the surface pass `placeFlora` from `FLORA_TABLE` — an array indexed
  by BIOME id (null for OCEAN and SNOWY_PEAKS) of `{ surface, rows: [{ id, chance, top?, minHeight?, maxHeight?, besideBelow? }] }`,
  one roll per column compared with cumulative chances (`top: true` replaces the surface with GRAVEL; plants and litter go at height + 1).
  The generator exposes `gen`, `pondAt(q, r)` (true only for pond water columns), `treeTrunkAt`, `FLORA_TABLE`; the module also
  `ORE_TABLE_GEN2, FLORA_TABLE, POND_CELL, POND_SALT, FLORA_SALT`. A warm gen-2 chunk stays within the 8 ms budget.
- **World** (§9): `new World({ …, gen })`, `world.gen`; `columnAt(q, r) → { height, biome, temperature }` (a fresh object from the
  generator); `findSurvivalSpawn()` — findSpawn's spiral accepting only PLAINS / FOREST at height ≥ SEA_LEVEL + 2, falling back to
  `findSpawn()`, cached per world, returns copies; `findSpawn` and Creative are unchanged.
- **Pop-off** (§34): `fallingblocks.GRAVITY_RULE_IDS = [SAND, RED_SAND, GRAVEL, ...POP_OFF_IDS]`; the gravity rule, the falling trigger
  and the gravity reseeder treat `isPopOff(id)` like CAMPFIRE: the cell is written AIR when its floor becomes fall-through, with
  `popOffEffect(id)`'s puff (plants 6 leaves, prickly pear green dust, stones and the pit grey dust, branches bark dust; sounds
  break:leaves / break:stone / break:wood); popped blocks drop nothing. The `ignite` trigger stays CAMPFIRE only.

## 48. Survival screens, rendering and sound — hud, menus, packUI, itemIcons, itemArt, handbookUI, renderer, campfireRenderer, audio

- **Look** (DESIGN-survival §11): every survival element uses the pack palette (dark #1c1a24, honey #e8b04a, ember #d0582a) and
  `.hex-button`; none uses `.mc-button` or `.picker-panel` (tested). No hearts, drumsticks, bubble rows, square slot grids, crack
  textures or diagonal tool icons.
- **hud.js** adds (each touches the DOM only when its rounded value changes: health / nourishment / hydration to integers,
  temperature and felt to 0.1, breath to its edge count `ceil(breath / (BREATH_MAX_S / 6))`; pure `vitalsKey`):
  `setSurvivalVisible(on)`, `setVitals({ health, satiation, hydration, temp, felt, breath, labels, target? })` (the bookends
  `#vitals-left` Health + Nourishment and `#vitals-right` Hydration + the body-temperature gauge with a ▲/▼ trend; Breath is the Health
  cell's six-edge border, ember-pulsing at 0; `#status-chips` coloured by kind), `setHotbarStacks(pack.slots | null, selected,
  version)` (the hex survival hotbar, slots 0–8, redrawn when `version` or `selected` changes; null → Creative's hotbar back from the
  ids last given to `setHotbar`; main passes the live array every frame, no copy), `setActionProgress(p | null)` (`#action-ring`),
  `setJobChip(text | null)` (`#job-chip`), `addPickup(key, n, {x, y} | null)` (a 16 px hex token flies to its slot, or the pack
  glyph, which pulses). **Adjudicated (E):** the bookend cells are 38 × 44 px pointy-top hexes (a 44-wide cell is 51 tall, which left
  13 px for the chips under `#chat-log`), bottoms 8–52 px, chips 54–70 px.
- **menus.js** adds: the Mode switch (`#pause-mode` row after Creatures, `#btn-mode` with halves `#btn-mode-creative` /
  `#btn-mode-survival`, the active one honey with `aria-pressed="true"`; `setModeState(mode)`, `getModeState()`; callback
  `onModeSelect(mode)` from the inactive half only); `PhysicsMenuState.survival` (Undo disabled, `undoButtonLabel(canUndo, kind,
  survival)` → "Undo (not in Survival)"); the death screen `#death-screen` (z 33: a honeycomb SVG mask closing ring by ring over 1.2 s
  on #1c1a24 at 85 %, `#death-title` in honey, `#death-detail`, `#death-where` hidden when empty, `#btn-wake` "Wake up" as a
  `.hex-button`, `#btn-death-quit` "Save & quit" as a text link; `showDeath(title, detail, where?)`, `hideDeath()`, `isDeathOpen()`,
  callbacks `onWake`, `onDeathQuit`); `confirm({ title, detail, yes, no, danger }) → Promise<boolean>` on `#confirm-dialog` (every call
  resets its labels; `hidePause`, `showTitle`, `dispose` and a newer question resolve a pending one false; the world-delete flow runs
  on it); the New World form's checkbox → `onNewWorld(slot, name, seedText, { survivalResources })`; Worlds rows append `· Survival`
  (`SlotInfo.mode`); the controls sheet keeps 17 rows with the survival wording. §14 (package H): a Guide button on the title screen and
  in the pause menu → `onGuide()`.
- **packUI.js**: `createPackUI(doc, itemIcons, callbacks) → { open(view), refresh(view), close(), isOpen(), dispose() }`; callbacks
  `onSlot(area, index, button, shift)`, `onDiscard()`, `onMake(recipeId, times)`, `onCancelJob(lane, i)`, `onTab(id | 'all')`,
  `onClose()` (Esc, E or the close hex; a document listener only while open, repeats ignored), `onRead()` (§14). `#pack-screen` z 20
  (the picker's layer; never open together): flat-top hexes — an 18-slot rosette (slots 9–26, ring 1 then ring 2, clockwise from the
  top; pure `rosetteCells`) around a centre info hex, a 9-cell zig-zag hotbar strip, the head / body / feet wear chain and a red discard
  hex; a basket opens as a second rosette replacing the Making panel; Making = station tabs (far ones dimmed), mini-rosette recipe
  cards (output in the middle, inputs with have/need, the tool chip, time, Make / ×5) and the busy lanes with ✕. **Adjudicated (E):**
  the centre hex shows the icon with its wear outline; the name and "45/90" sit on the line under the rosette. All item logic stays in
  main, survivalControl and inventory.js; the view is `survivalControl.buildPackView({ pack, selected, cursor, hover, container,
  stations, tab, recipes: crafting.listRecipes(…, { queue }), lanes: craftQueue.lanes() })`; `demoPackView()` is the `?ui=pack` demo.
- **itemIcons.js / itemArt.js**: `createItemIcons(doc, atlasCanvas) → { draw(ctx, key, size), canvas(key, size) }` — block items with
  `drawBlockIcon` (**adjudicated (E):** the two bush items show the RIPE bush, `iconBlockFor`, although `blockForItem` returns the
  picked block), every other item from a lazily painted 16-column sheet of `itemArt.paintItem(key)` (16 × 16 RGBA, deterministic; tools
  upright with the haft in columns 7–8, the tier in the head colour AND the binding; hexagonal ingots; unknown keys the magenta
  checker).
- **The Handbook readers** (§14.4, `handbookUI.js`; imports handbook only): `createHandbookUI(doc, { chapters?, onClose? }) →
  { openGuide(chapterId?), openRustic(chapterId?), close(), isOpen() → 'guide'|'rustic'|null, handleKey(e) → boolean, position() →
  { mode, chapter, page, spread }, dispose() }`; chapters default to the pure `handbook.buildChapters()` (generated tables come from
  the data tables, so the book never disagrees with the game); either reader replaces the other without an `onClose`; `onClose(kind)`
  fires once when a reader closes (Esc, the close hex, a click on the backdrop, R in the field book, or `close()`). **The Guide**
  (`#guide`, the survival palette and `.hex-button` chrome): a chapter list and a scrollable page; ↑/↓ chapters, PgUp/PgDn and ←/→
  pages; opened by `menus.onGuide(from)` from `#btn-guide-title` and `#btn-guide-pause` ("Survival Guide" `.hex-button.guide-button`,
  both modes; the screen underneath stays). **The field book** (`#handbook`, the item): parchment from CSS gradients and a
  procedural grain canvas (`paintPaperGrain`), a two-page spread (`bookPages`: a title page and contents, every chapter on a left-hand
  page; one page at a time below `SINGLE_PAGE_BELOW_PX` 900), chapter tabs, ←/→ and the page corners turn, tips and warnings in the
  pencilled margin; opened by R / RMB with the item or the pack screen's "Read" hex (`packUI.onRead`). **z-order** (styles.test):
  `#handbook` 21 (over the HUD 10 and the pack screen 20; under the console 22, the pause menu 30 and the death screen 33); `#guide`
  32 (over the pause menu, under the death screen), lifted to 55 with `.over-title` while the title screen (50) shows, still under
  the confirm dialog (60). main routes keydowns to `handleKey` first (a capture listener) while a reader is open; the reader's own
  document listener and that route act on an event once.
- **renderer.js**: `setDigProgress(hit | null, p)` — a honey `LineSegments` of the highlight prism's 6 vertical and 6 top edges, drawn
  to `2·ceil(12·p)` vertices (`digTraceVertexCount`), renderOrder 3, hidden for null or p ≤ 0, disposed in `dispose()` and rebuilt after
  a context restore. **Adjudicated (F's CONTRACT-ISSUE):** "clockwise from the north corner" = `DIG_TRACE_CORNER_ORDER [5, 0, 1, 2, 3,
  4]`, increasing corner angle measured from +X toward +Z, which turns CLOCKWISE on a north-up picture seen from above (see the note in
  §0).
- **campfireRenderer.js** (§32): `sync(near, t, dt, spotsView?)` with `spotsView(fire) → fireSlots.view(…)`; 12 InstancedMeshes (9 + skewers,
  food chunks coloured raw → cooked #8a5a2b → burnt #2a2018, terracotta hex pots), all in `prewarm()`; a fire with nothing on its spots
  still costs 9 draw calls; while spot 6 holds a pot the flames are squashed (POT_FLAME_SQUASH 0.35, widened × 1.25) so the pot shows.
  `SPOT_ITEMS` copies FIRE_TRANSFORMS' keys (the renderer may not import cooking.js; a test checks them against each other).
- **audio.js** adds `playHurt(v), playDeath(), playEat(), playDrink(), playDig(group, v)` (reuses BREAK_CUTOFF_HZ), `playCraft(),
  playToolBreak(), playSizzle(v), playPick()` — synthesised, every one with an optional volume, silent when muted.

## 49. Survival integration — `src/main.js` and `src/diagnostics.js`

**Objects** (one per session, reloaded from every save in `startLoading`): `survival, pack, containers, fireSlots, regrowth, tapped,
craftQueue, digState, useState` (RMB), `holdState` (R holds), `stations`, `climateSample`, and the slots `releaseToPack, pendingDeath,
pendingKnock, pendingModeSwitch, waterHit`. States add `PACK 'pack'`, `BOOK 'book'` (the rustic Handbook) and `DEAD 'dead'`.
**`stepFrame(dt)`**: a queued mode switch first (`applyModeSwitch`: in PLAYING / PAUSED / CONSOLE / EDITOR; an upgrade calls
`startLoading` and ends the frame); then PLAYING, PACK and BOOK run `stepPlaying` (PACK and BOOK with the controls disabled, so the
player stands still while the world runs: lanes progress, fires cook, vitals drain, zombies come); DEAD and every other state step
nothing (`main.stateSimulates`). The pack screen refreshes when `pack.version`, `craftQueue.version`, `containers.version`, the
stations or the tab change.
**`stepPlaying(dt)`**, SV = `survival.inSurvival`, S = `survival.active`:
1. fly toggle only if !SV; KeyE → SV ? pack screen : picker; T, /, digits, F3, M as before.
2. R: Shift+R → editor (both modes); SV → `survivalR` (§44 `interactKind`; tap and relight held through `holdState`; put, feed and
   gulps repeat every R_REPEAT_S 0.25 while held, a gulp at most every GULP_GAP_S; with nothing to do → `interactTarget()`: barrels and
   runes as today); Creative → `interactTarget()`.
3. Mouse: Creative exactly as before. SV: LMB → a lit barrel is snuffed (as today); a zombie or pig is struck on the press and every
   ATTACK_REPEAT_S 0.55 while held (`strikeKind`: zombies `hit(zb, x, z, power)`, a 'ko' drops a Grave Rag 50 %; pigs `wound` with a
   tool (a 'dead' pig: grey-pink dust, a squeal, raw pork 2–3, rawhide, pig fat 60 %, straight into the pack), `hit` by hand; each hit
   that lands wears the tool 1); else hold-to-dig (`digState` with `breakSeconds(id, tool, headInWater)`; every DIG_TICK_S
   `playDig(group, 0.35)` and 3 dust motes `{ id }` at the hit face; a block the hand cannot break: a dull `playDig(group, 0.15)` every
   0.5 s). **Finishing**, in order: `natural = !world.hasEdit` (BEFORE), `rollDrops`, `pack.canGive(drops + container contents + fire
   spots)` else the hint `Pack full` and the dig stays complete, the break `playerSetBlock(AIR)` inside `releaseToPack = true`,
   `playBreak`, the drops with pickup tokens, 1 wear on the selected tool ("Your Flint Axe broke." + `playToolBreak`). RMB → the
   Handbook opens at once; a block item places (Creative's rules, `placeRefusal`'s `needs solid ground`, `pack.consume(selected, 1)`,
   a campfire gets `fireSlots.light(…, 300)`; PLACE_REPEAT_S when held); food / pots / bandages / wear through `useState` (a drunk pot
   comes back into the hand). MMB → `pack.hotbarSlotOf(itemForBlock(id))` only (never conjures).
4. While S: `input.sprint &&= status.canSprint`, `input.speedFactor = status.moveFactor` (else 1).
5. Physics, then `stepBlackHoles` (S: swallowed → `pendingDeath ??= 'blackhole'`, no teleport) → **checkpoint** → pigs → zombies (S:
   `hurt(ZOMBIE_DAMAGE × attacks, 'zombie')`) → watcher → `stepBlockPhysics` (`b0 = explosions.blastCount`; `blockPhysics.step`; the
   knock hook's player branch only records `pendingKnock = max(…, |Δv|)`; then S → `hurt(knockDamage(pendingKnock), blastCount ≠ b0 ?
   'blast' : 'log')`; `pendingKnock = 0`) → `stepCampfires` (S: a scorch → `hurt(FIRE_BURN_DAMAGE, 'fire')`, ≤ 1 / 0.5 s) →
   **checkpoint** → bodies → `unstickPlayer() → { lifted, buried }` (crush per §45) → the clock → while S `stepSurvival(dt, buried)`
   → **checkpoint** → `runner.update` (PLAYING only) → **checkpoint** → streaming, `updateHit`, `autosaveTick`.
6. **`stepSurvival`**: every CLIMATE_SAMPLE_S 0.5 `main.sampleClimate(world, player)` (feet column `world.columnAt`, `zombies.openSky`
   over the eye, underground, ground chill) + heat sources (burning campfires within 8, working kiln / bloomery / forge lanes) at the
   chest, `nearFire` (a campfire within NEAR_FIRE_CELLS 4) and `findStations`; the soft-landing factor from `physics.supportingCells` on a
   hard landing; `survival.step` (`fall` → hurt flash and sound, `pulse` → flash 0.4 and `playHurt(0.4)`, any damage closes the field
   book, `died` → `pendingDeath ??= died`); `craftQueue.step(dt, pack, world.peekBlock, feetCell)` (failure lines to chat, broken tools,
   `playCraft`); `fireSlots.step(dt, isBurning, isLoadedCell)` (burnt-out → `world.setBlock(FIRE_PIT)` + smoke; smoke over meat, steam
   over pots and a sizzle within 6 cells); once a second regrowth (lazy writes) and spoilage; pig repopulation every PIG_REPOP_CHECK_S
   150 in daylight (at PIG_MAX prune one far unloaded pig beyond 2·PIG_REPOP_RADIUS; with fewer than PIG_REPOP_TARGET 3 within
   PIG_REPOP_RADIUS 64, `spawnNatural(2, …, seed ^ (day·7919 + n), …, PIG_REPOP_MIN 24, PIG_REPOP_MAX 48, [GRASS_BLOCK, SNOWY_GRASS])`);
   feet below VOID_Y −32 → `pendingDeath ??= 'void'`.
**`hurt(amount, cause)`**: nothing unless S; `survival.damage`; a lethal hit only sets `pendingDeath ??= cause`; else the flash `min(1,
0.4 + dmg/20)` and `playHurt` (≤ 1 / 0.3 s). **Never `die()` from a hook, a command, a rune or an explosion.**
**`die(cause)`** (checkpoints only): close the pack screen (cursor back; overflow lost) and the field book; `pack.dumpAll()` into a
REMAINS cell from `chooseBelongingsCell(getBlock, feet)` (scan down ≤ 8 to ground, then that cell, up to 3 above, then the 6 side
neighbours; the first replaceable) written with `world.setBlock` and `containers.addRemains` — none for `blackhole` / `void` or when no
cell fits (lost); `survival.dead = cause`, `deaths++`, lanes cleared, inputs reset; `setState(DEAD)` BEFORE `controls.unlock()`;
`menus.showDeath(deathTitle(cause), "Your belongings lie where you fell." | "Your belongings are lost." | "You carried nothing.",
"Your belongings lie at q Q, r R, height Y.")` (`main.deathScreenText`); `playDeath()`; `doSave(false)`. **Wake up**: `survival.respawn()`,
the Handbook back if missing, then the Sleeping Hide (its chunk loaded for ≤ 200 ms behind the screen; on the hide with `findFreeY(…,
hideY + 1, 3)`; still unloaded → trust it; gone → "Your Sleeping Hide is gone.") or `blackHoles.respawnPoint(world.findSurvivalSpawn(),
…)`; `game.teleport` (fallGrace), hide the screen, `enterPlayingFromModal()`. **Save & quit** saves, then quits to the Worlds screen. A
save with `survival.dead` reloads straight onto the death screen (`main.stateAfterLoading`): never click-to-play or play;
`enterPlaying()` returns early while dead. The reloaded screen names the nearest REMAINS entry, if any.
**`updateHit`**: `hit` as before (Creative's WATER-selected source ray stays Creative-only); in SV with a dry eye a second ray
`waterHit` stops at any water (`isTargetable || isWater`; kept only when it is water; dropped when a mob or a lit barrel takes the
crosshair). **Target hints** (SV): `Pig · click: hunt it` / `… shove it (hunting needs a tool)`, the campfire line (`Campfire · 3
roasting (next 14 s) · 2 done · fuel 4:10 · R: take`; the fuel part only for fires with fuel), the pit, `<Plant> · R: pick`, birch,
water (`Fresh water · R: drink`, `Sea water (salty) · R: drink`, `… · R: fill the pot`), basket, `Your Belongings · R: take back`,
`Sleeping Hide · R: wake here`, `Kiln · R: open Making`, `Handbook · R: read`, the tier hint (`Iron Ore · needs a bronze pick or
better`), `Pack full`, then barrels and runes as before; short-lived refusals (`needs solid ground`, `The fire is fully fed`, …)
for 1.6 s. Creative: `breakTargeted` refuses — with `Holds survival items · switch to Survival to empty it` — a WICKER_BASKET or REMAINS
that holds items and a CAMPFIRE or FIRE_PIT whose spots hold anything.
**`onBlockChanged`** (after campfires, before blockPhysics): `containers.onBlockChange`, `fireSlots.onBlockChange` (released stacks to
the pack while `releaseToPack`), `regrowth.onBlockChange`. **`renderFrame`**: `renderer.setDigProgress(digHit, progress)`,
`campfireRenderer.sync(…, spotsView)`, `hud.setSurvivalVisible(SV)`, `hud.setHotbarStacks(SV ? pack.slots : null, selected,
pack.version)`, and in SV `setVitals` (with `target = bodyTarget(felt, inWater)`), `setActionProgress` (dig, else RMB use, else R hold),
`setJobChip(craftQueue.chipText())`.
**Loading** (`startLoading(seed, restoring, { survivalResources })`): `gen = main.loadingGen(…)`; `new World({ …, gen })`;
`survival.import(save.survival)`; `survival.mode = main.loadingMode(save, gen).mode`; a Survival world without a state begins one;
`pack.load`, `fireSlots.load(save.survival.fires)`, `containers.load(save.containers)`, `regrowth.loadFromEdits(world.edits)`, everything
else cleared. `finishLoading`: `?mode` (first world only, `main.consumeModeParam`); in SV `flying = false` (whatever ?fly says),
`landSpeed = 0`, fallGrace; the upgrade note and the begin lines (with `ensureHandbook`); then DEAD, autoplay or click-to-play.
**Saving**: `buildSaveData` spreads `main.survivalSaveFields(…)`; `autosaveTick` also saves every interval while S and when
`survival.switchVersion`, `pack.version`, `containers.version` or `fireSlots.version` changed. **Pause**: `menus.setModeState(mode)`;
the physics state carries `survival: SV` (`main.physicsMenuStateFor`); `onUndoPhysics` refuses in SV. `quitToTitle` / `dispose` clear
every survival object, close the pack screen, the death screen and any reader, and hide the survival HUD.
**CommandContext.survival** (§26): `{ mode, hasState, setMode(m) → { ok, message }` (queued; "already m", "adding survival resources to
this world: reloading…", "m (saved with this world)"; refused while dead), `vitals() → {…vitals, labels} | null, setVital(name, v)`
(health 0 → `pendingDeath ??= 'command'`, never a death inside the command), `restoreVitals(), packAdd(key, n) → leftovers | null,
packClear(), packList() }`.
**GameContext** (diagnostics; types.js's typedef lists them, §3): `survival, pack, setMode(mode)` (queued), `getMode()`,
`urlMode`, `selectSlot(i)`, `interact()` (one R press), `digTargeted(dt)` / `useSelected(dt)` (one frame of the real hold-to-dig /
hold-to-use paths). The debug handle adds `survival`, `pack` (refreshed like `world`), `getMode / setMode / selectSlot / digTargeted /
useSelected / interact`.
**The Handbook wiring** (§14.4; `handbook.js` and `handbookUI.js` are static imports — `HANDBOOK_KEY, HANDBOOK_CHAT_LINE,
buildChapters, ensureHandbook` and `createHandbookUI`; the readers are built with the other screens, so a failure there is a failure
to start): `menus.onGuide` → `openGuide()` from the title or the pause menu (both modes; the menu stays underneath); R `read` and RMB
with the Handbook → `openBook()` (state BOOK; the world keeps running; damage closes it, `closeRusticBook`); `packUI.onRead` → close
the pack, open the book; while a reader is open keydowns go to `handleKey` first; `ensureHandbook(pack)` after a state begins (the
chat line's Handbook sentence only when it was given) and after waking; `quitToTitle` / `dispose` close any reader. The console's
`pack add` / `pack clear` go through the pure `consolePackAdd(pack, key, n)` / `consolePackClear(pack)` (§26.4).
**Diagnostics** (§22): `parseParams` adds `mode` (`readModeParam`: 'creative' | 'survival' | null) and `ui: 'pack'` (the pack screen in
Survival; under ?nosave an empty pack is stocked with `demoPackView()`'s kit). `?mode=` applies only to the first world, only with
`?autoplay` / `?smoke` (`main.modeParamPlan`: always for Creative; Survival for a new slot, any world under ?nosave — its generation may
be raised — or a generation-2 world; an older saved world loads as it is with `?mode=survival ignored: this older world needs the
in-game upgrade (Esc → Mode)`); then `params.mode` is null. F3 adds, while S, `Survival: HP 87 · Nourishment 64 · Hydration 51 · Breath
20 · body 36.9 °C · felt 12.3 °C (air 9.8) · Chilled` after `Mode:` (`survivalDebugLine`). The smoke test switches to Creative first
when needed (queued; waits for it); with `?mode=survival` it ends with the survival step: back to Survival, `setblock ~ ~-1 ~ stone`,
`pack add flint_pick`, hold-dig the cell below (AIR, rock in the pack), `pack add honeyberries 2`, hold to eat one.

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
    (v0.9: Survival is such a feature — in Creative or while dead nothing survival steps, and nothing catches up afterwards.)
29. (§41) Never trust the slot index without checking it against the slot's text (bytes + hash), never write a save as two copies (no
    room for that), never remove the legacy save before its copy reads back identical, and never let a URL (?autoplay) overwrite a
    damaged slot. Under ?nosave nothing at all is written: not the migration, not the index repair.
30. (v0.9) Survival state is frozen in Creative; never convert between the two inventories (the creative `hotbar` of block ids and
    the survival pack of item stacks never exchange anything).
31. (v0.9) Never die, switch mode or reload a world from inside a hook, a command or a rune: queue it (`pendingDeath`,
    `pendingModeSwitch`) and act at the frame's checkpoints (§49).
32. (v0.9) Compute `natural = !world.hasEdit(q, y, r)` BEFORE a Survival break or pick writes the cell: the write itself records an
    edit, and checking afterwards makes every natural drop (all flint) impossible.
