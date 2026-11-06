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
| `src/atlas.js` | DOM + three | A-atlas | — |
| `src/renderer.js` | three | A-renderer | `tests/unit/renderer.test.js` |
| `src/controls.js` | DOM | A-controls | — |
| `src/hud.js` | DOM | A-hud | — |
| `src/menus.js` | DOM | A-menus | — |
| `src/audio.js` | DOM (WebAudio) | A-audio | — |
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
main                               → everything except three
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
`VERSION = '0.2.0'`. Render/data/unload radii are **hex distances** in chunk coordinates. `FACE_SHADE` moved to `hex.js`
(it derives from the face normals). `TOP_UV_SCALE = √3/2` (hex caps are inscribed in their tile).
Commands / runes: `GAME_SECONDS_PER_DAY, MAX_FILL_CELLS, MAX_TOTAL_EDITS, MAX_CELLS_PER_FRAME, MAX_COMMANDS_PER_FRAME,
MAX_RUNNING_SCRIPTS, MAX_CHAIN_HOPS, CHAIN_DELAY_S, MAX_RUNES, MAX_RUNE_SCRIPT_CHARS, MAX_RUNE_SCRIPT_LINES, MAX_RUNE_LABEL_CHARS,
WAIT_MIN_S, WAIT_MAX_S, REPEAT_MIN_S, REPEAT_MAX_S, STEP_COOLDOWN_MAX_S, AREA_MAX_RADIUS, AREA_MAX_HEIGHT, MAX_CONSOLE_LINES,
CONSOLE_HISTORY, CHAT_LINES, CHAT_LINE_MS` (values in the file; §26–§28 use them by name).
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
`lookDirection(yaw,pitch) → [-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch)]`.
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
WOOL_BROWN 62, WOOL_BLACK 63, WOOL_GRAY 64, WOOL_LIGHT_GRAY 65`, v0.5 `BLACK_HOLE 66` (§29). `BLOCK_COUNT = 67`. All v0.4 blocks are solid, breakable and
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
PUMPKIN_SIDE 56, PUMPKIN_TOP 57, WOOL_ORANGE 58 … WOOL_LIGHT_GRAY 71` (wool in BLOCK order), v0.5 `BLACK_HOLE 72`, `MISSING 255`.
`TILE_IDS` = array of all 74 tile ids.

Layers: `LAYER_OPAQUE 0` (everything else), `LAYER_CUTOUT 1` (OAK/SPRUCE/BIRCH_LEAVES, GLASS), `LAYER_TRANSLUCENT 2` (WATER, ICE).

Biomes: `BIOME.OCEAN 0, BEACH 1, PLAINS 2, FOREST 3, DESERT 4, SNOWY 5, MOUNTAINS 6, SNOWY_PEAKS 7`, `BIOME_NAMES`.

`BLOCKS[id]` → `{ id, name, displayName, tiles:[8], solid, opaque, liquid, breakable, placeable, cullSame, layer, soundGroup }`.
`tiles` has **8 entries indexed by face**: six sides, then top (6), then bottom (7).
Functions: `getBlockDef(id)` (unknown → the AIR def), `isSolid, isOpaque, isLiquid, isBreakable, isPlaceable,
isReplaceable (AIR or liquid), isTargetable (not AIR and not liquid), getRenderLayer, getFaceTile(id, face 0..7),
shouldRenderFace(a, b), tileToUV(tile) → [u0, v0, u1, v1]`. Re-exports `FACE_TOP, FACE_BOTTOM` from hex.js.
Constants: `DEFAULT_HOTBAR` (9 ids), `PICKER_ORDER` (all 65 placeable ids, once each, grouped stone / earth / wood / minerals /
wool / special, ending BLACK_HOLE, RUNE_BLOCK, WATER), `SOUND_GROUPS`.

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
  editVersion = 0;    // incremented on every successful setBlock (autosave uses it)
  onChunkMesh   = (key, cq, cr, meshData) => {};   // assignable hook, called synchronously from update()
  onChunkUnload = (key) => {};                     // assignable hook
  onBlockChange = (q, y, r, prev, next) => {};     // assignable hook, called synchronously from setBlock ONLY, after the edit is
                                                   // recorded and chunks are dirtied; never from importEdits / applying saved edits
  get editCount()            // total recorded edit entries across all chunks (area commands budget against MAX_TOTAL_EDITS)
  getBlock = (q, y, r) => BlockId;      // ARROW PROPERTY. CELL coords. AIR when y out of range or chunk not loaded. Never allocates.
  getChunkData = (cq, cr) => Chunk|null; // ARROW PROPERTY.
  getBlockAt(x, y, z)        // WORLD position convenience: getBlock(...worldToHex(x, z), floor(y)); AIR for non-finite input
  setBlock(q, y, r, id)      // CELL coords. boolean: false if y out of range, id not an integer 0..255, chunk not loaded, or unchanged.
                             // On success: chunk.set, edits record, editVersion++, and marks dirty every LOADED chunk
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
2. Re-mesh edited chunks: every loaded chunk with dirty && meshed && all 6 hex neighbours loaded → mesh now (ignores budget).
3. Walk RING_OFFSETS = all (dq,dr) with hexLength(dq,dr) <= renderDistance + DATA_RADIUS_EXTRA, sorted by hexNormSq(dq,dr)
   ascending (ties: dr then dq ascending). For each: cq = pcq+dq, cr = pcr+dr, chunk = chunks.get(key):
   if !chunk: data = worldGen.generateChunk(cq,cr); chunk = new Chunk(cq,cr,data); apply edits.get(key) (blocks[li] = id per pair);
              chunks.set(key, chunk); builds++; generated++; if overBudget() break
   if hexLength(dq,dr) <= renderDistance && chunk.dirty && all 6 hex neighbours loaded:
              m = buildChunkMesh(cq, cr, this.getChunkData); chunk.dirty = false; chunk.meshed = true;
              onChunkMesh(key, cq, cr, m); builds++; meshed++; if overBudget() break
   pendingGen / pendingMesh = counts of remaining ring entries that still need work (computed cheaply at the end or as the walk proceeds).
```
Guarantee: at least one build per call when work is pending (budget is checked after each build). With `budgetMs = Infinity`
and `MAX_BUILDS_PER_UPDATE` respected, repeated calls converge to `pendingGen === 0 && pendingMesh === 0`: `hexDiscCount(rd)`
meshed chunks and `hexDiscCount(rd + DATA_RADIUS_EXTRA)` loaded. Because a chunk is meshed only once its 6 hex neighbours
exist (the mesher never reads anything else), generation never invalidates an existing mesh.
Missing `performance` (Node < 16) → use `Date.now`. Tests pass `now: () => 0` and `budgetMs = Infinity`.

## 10. `src/mesher.js`

```js
export function buildChunkMesh(cq, cr, getChunkData)   // → ChunkMeshData { opaque, cutout, translucent } (null layer when 0 faces)
export function vertexAO(side1, side2, corner)          // (side1 && side2) ? 0 : 3 - (side1 + side2 + corner); args 0|1  (side faces)
export function hexCornerAO(sideA, sideB)               // 3 - (sideA + sideB)                                            (hex caps)
export function isTintedFace(id, face)                  // OAK_LEAVES: every face; GRASS_BLOCK: FACE_TOP only
export const BIOME_TINT                                 // [r,g,b] × 8 biomes, multiplied into tinted faces
export function createMeshBuilder(initialVertices = 1024) // growable buffer helper; ensure(vertices, indices), reset(), build()
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
(`Q = P + HEX_DIRS[f]` for sides, `±1` in y for caps). Emit iff `shouldRenderFace(a, P(Q))`.
1. `topY = (a === WATER && P(lq+1, ly+1, lr+1) !== WATER) ? WATER_SURFACE_HEIGHT : 1`. Applies to EVERY top vertex of that
   water cell: the top corners of all six side quads and the whole top hexagon sit at `ly + topY`.
2. **Side face `j`** (quad, 4 vertices, CCW from outside): `v0 = bottom corner j+1`, `v1 = bottom corner j`, `v2 = top corner j`,
   `v3 = top corner j+1` (so v0/v3 are the LEFT edge seen from outside, v1/v2 the RIGHT). Position `C + HEX_CORNERS[k]`,
   `y = ly` or `ly + topY`; normal `FACE_NORMALS[j]`. AO per vertex with `third` = the neighbour sharing that corner's vertical
   edge (`HEX_DIRS[j+1]` for corner j+1, `HEX_DIRS[j−1]` for corner j) and `dy = top ? +1 : −1`:
   `s1 = isOpaque(third, ly)`, `s2 = isOpaque(Q, ly+dy)`, `c = isOpaque(third, ly+dy)`; `ao = vertexAO(s1, s2, c)`.
   UV: `uMid = (u0+u1)/2`, `uHalf = (u1−u0)·HEX_SIZE/2` (texel density 1 tile per unit); left vertices `u = uMid − uHalf`,
   right `uMid + uHalf`; bottom `v = v1`, top `v = v0`. Indices with `b` = vertexCount before the quad:
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
export function playerIntersectsBlock(p, q, y, r)      // strict: hexCircleContact(cell centre, p.x, p.z, PLAYER_RADIUS) && p.y < y+1 && p.y+PLAYER_HEIGHT > y
export function findStandingY(getBlock, x, z, fromY)   // in the cell column under WORLD (x,z): scan down from fromY for the first y where
                                                       // block(y-1) solid and blocks y, y+1 not solid; null if none / non-finite input
export function isFreeAt(getBlock, x, cy, z)           // cylinder with feet at (x, cy, z) overlaps no solid cell (7-column test)
export function findFreeY(getBlock, x, z, fromY, maxUp = 2) // first free feet height among fromY, fromY+1, …, fromY+maxUp; null if none
export function supportingCells(p, getBlock, out = [])  // [q,y,r] of the cells under the player's footprint whose cell at floor(p.y − 1e-3)
                                                       // is solid (empty when airborne); the step-on trigger is edge-triggered on this set
/** PlayerState = { x,y,z, vx,vy,vz, onGround, flying, sneaking, sprinting, inWater, headInWater, hitWall }
 *  PlayerInput = { forward: -1|0|1, strafe: -1|0|1, jump, sneak, sprint: boolean, yaw: number, pullX?, pullY?, pullZ?: number }
 *  pull* (v0.5, black holes) are accelerations in m/s², default 0, added every substep in EVERY mode: vx/vz += pull·h after the
 *  horizontal relaxation, vy = max(vy + pullY·h, TERMINAL_VELOCITY) after the vertical rule. */
```
The player is a **vertical cylinder** of radius `PLAYER_RADIUS` and height `PLAYER_HEIGHT`. Because the radius is smaller than
a cell's inradius, the footprint can only overlap the cell containing `(x, z)` and its six neighbours; the collider examines
exactly those 7 columns (`gatherColumns`).
### 12.1 Substep of `h` seconds (normative)
```
1. Environment: (bq, br) = worldToHex(x, z); feet = getBlock(bq, floor(y+0.1), br); chest = getBlock(bq, floor(y+1.0), br)
   inWater = isLiquid(feet) || isLiquid(chest)
   eyeY = y + getEyeHeight(p); eyeCell = getBlock(bq, floor(eyeY), br); above = getBlock(bq, floor(eyeY)+1, br)
   headInWater = isLiquid(eyeCell) && (isLiquid(above) || (eyeY - floor(eyeY)) < WATER_SURFACE_HEIGHT)   // only the topmost water block has a lowered surface
   sneaking = input.sneak && !flying;  sprinting = input.sprint && input.forward > 0 && !sneaking
2. Horizontal: [fx,fz] = yawToForward(input.yaw); [rx,rz] = yawToRight(input.yaw)
   wx = fx*forward + rx*strafe; wz = fz*forward + rz*strafe; normalise (wx,wz) if its length > 1
   speed = flying ? (sprinting ? FLY_SPRINT_SPEED : FLY_SPEED) : sneaking ? SNEAK_SPEED : sprinting ? SPRINT_SPEED : WALK_SPEED
   if (inWater && !flying) speed *= WATER_SPEED_FACTOR
   accel = (flying || onGround) ? GROUND_ACCEL : inWater ? WATER_ACCEL : AIR_ACCEL;  k = 1 - exp(-accel*h)
   vx += (wx*speed - vx)*k;  vz += (wz*speed - vz)*k
3. Vertical:
   flying:  target = ((jump?1:0) - (sneak?1:0)) * FLY_VERTICAL_SPEED;  vy += (target - vy) * (1 - exp(-GROUND_ACCEL*h))
   inWater: if jump: vy = hitWall ? SWIM_EXIT_JUMP : SWIM_UP_SPEED;  else vy = max(vy + WATER_GRAVITY*h, WATER_MAX_SINK)
   else:    if (jump && onGround) vy = JUMP_VELOCITY;  vy = max(vy + GRAVITY*h, TERMINAL_VELOCITY)
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
 *   selected: number, edits: EditsJSON, runes?: RunesJSON }   EditsJSON = { "cq,cr": [localIndex, id, localIndex, id, ...] } */
```
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
/** callbacks = { onNewWorld(seedText: string), onContinue(), onResume(), onSave(), onStopRunes(), onQuit(), onClickToPlay(), onPickBlock(blockId, slot|null), onPickerClose() }
 *  (#btn-stop-runes "Stop All Rune Scripts" in the pause menu fires onStopRunes; CONTROLS_SHEET lists T, /, R and Shift+R)
 *  Menus = {
 *   showTitle(hasSave), hideTitle(),        // sets a random splash, dirt background (makeTiledBackgroundDataURL DIRT), draws the logo, renders the controls sheet, enables #btn-continue iff hasSave
 *   showLoading(done, total), hideLoading(),
 *   showClickToPlay(), hideClickToPlay(),
 *   showPause(seed), hidePause(),
 *   showPicker(hotbar, selected), hidePicker(), isPickerOpen(),   // scrollable grid of PICKER_ORDER icons (64px canvases shown at 52px); click → onPickBlock(id, null); Digit1-9 while hovering → onPickBlock(id, slot)
 *   getSeedInput(),                         // text of #seed-input
 *   dispose() } */
```
New World with an existing save must `confirm("This will delete your saved world. Continue?")` before calling `onNewWorld`.

## 21. `src/audio.js` (WebAudio, optional feel)

```js
export function createAudio()   // → Audio; everything is a no-op when AudioContext is unavailable
/** Audio = { resume() (call on first user gesture), playBreak(soundGroup), playPlace(soundGroup), playClick(), setMuted(b), toggleMuted() → boolean, get muted } */
```
Synthesis per SPEC-gameplay §9.

## 22. `src/diagnostics.js` (DOM)

```js
export function parseParams(search = location.search)   // → Params { seed: string|null, rd: number|null (1..16), smoke, autoplay, nosave, debug, fly: boolean, time: number|null,
                                                         //            yaw: number|null (degrees), pitch: number|null (degrees, ±89.9), ui: 'console'|'editor'|null }
export function installErrorCapture(win, onError)        // window 'error' + 'unhandledrejection' → onError({message, stack})
export function installDebugHandle(win, game)            // win.__caelancraft = { version, ready:false, seed, world, player, controls, renderer, stats, errors:[], smoke:null,
                                                         //   getBlock(x,y,z) / setBlock(x,y,z,id) over WORLD positions (cell derived with worldToHex), getCell(x,z) → [q,r],
                                                         //   runCommand(line) → {ok, message}|null, runes (RuneStore), runner (RuneRunner|null), teleport, setTime }
export function updateDebugHandle(win, stats)            // refresh stats + ready flag (called by main every ~250 ms)
export function buildDebugText(game, stats)              // the F3 text block: XYZ (world), Cell (q y r) + chunk/local, facing, biome/seed, chunks,
                                                         //   target cell + face name + the cell's world centre (x z), time, mode
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
runner: RuneRunner, rune: Rune|null, running: Running|null, seed }`. The runner sets `rune`/`running` around each script command; the
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
export class BlackHoles {
  holes: Map<key, {key,q,y,r,cx,cy,cz,timer,offset}>; size
  add(q,y,r) / remove(q,y,r) / clear()     // add refuses duplicates and anything past BLACK_HOLE_MAX_TRACKED (256)
  onBlockChange(q,y,r,prev,next)           // BLACK_HOLE appears → add; disappears → remove; a swallowable cell appears → every hole whose
                                           //   ball (|dy| ≤ R, hex distance ≤ R) contains it restarts its search (offset = 0)
  loadFromEdits(world.edits)               // clear, then add every edit whose id is BLACK_HOLE
  pullAt(x,y,z,out?) → [ax,ay,az]          // Σ over holes with 0 < d < BLACK_HOLE_PULL_RADIUS: toward the centre, magnitude STRENGTH·(1−d/R)²
  swallowing(player) → hole|null           // first hole with playerIntersectsBlock(player, q, y, r)
  update(dt, {getBlock,setBlock,isLoaded}) → [{q,y,r,id}]   // see below
}
```
`update`: holes are visited round-robin (start index advances by one per call). A hole in an unloaded column, or whose search is
exhausted (offset past EAT_OFFSETS), is skipped without ticking. Otherwise `timer −= dt`; when `timer ≤ 0` and fewer than
BLACK_HOLE_MAX_EATS_PER_FRAME (4) cells were eaten this call, `timer += BLACK_HOLE_EAT_INTERVAL_S` (0.2 s, floored at 0) and the
hole scans EAT_OFFSETS from `offset` for the first `canSwallow` cell — stopping (no eat) at a cell whose column is unloaded — and
sets it to AIR via `setBlock`, reporting the old id. Over budget: `timer = 0` so it goes first-ready next frame.

main (§23): one `BlackHoles` for the session; `startLoading` calls `loadFromEdits(world.edits)` right after wiring
`world.onBlockChange`, whose handler forwards every change to `blackHoles.onBlockChange` first. `stepPlaying` writes
`pullAt(player.x, player.y + PLAYER_HEIGHT/2, player.z)` into `input.pullX/Y/Z` before `stepPlayer`, then (if any hole exists)
teleports a swallowed player to `world.findSpawn()` with the chat line "You were swallowed by a black hole!" and runs `update`,
playing at most one break sound per frame for an eaten cell within 16 units. `placeSelected` refuses a BLACK_HOLE that would
intersect the player (like solid blocks). Constants live in config.js (`BLACK_HOLE_*`).

## 30. `src/pigs.js` (PURE) and `src/pigRenderer.js` (three) — Pigs, v0.5

A pig is `createPlayer(x, y, z)` plus `{ id, yaw, targetYaw, mode: 'idle'|'walk'|'flee', timer, hurt, walkPhase, oinkIn }`,
moved by `stepPlayer` (so it collides as the player's cylinder, swims, hops one-cell ledges and feels black-hole pull).
Pigs never die. Constants `PIG_*` live in config.js.
```js
export function seededRng(seed)                // mulberry32
export function validatePigsJSON(raw)          // → { pigs: [{x,y,z,yaw}], warnings }: finite numbers, −16 ≤ y ≤ WORLD_HEIGHT, ≤ PIG_MAX kept
export class Pigs {
  list, size, clear()
  spawn(x, y, z, yaw = 0) → Pig|null           // null at PIG_MAX or non-finite input; mode idle
  remove(pig) → boolean
  update(dt, { getBlock, isLoaded(x, z), pullAt? }) → Pig[]   // oinks due this frame; pigs with y < −16 are removed;
                                                              //   pigs whose chunk is unloaded are frozen
  hit(pig, fromX, fromZ) → boolean             // false during the PIG_HURT_S flash; else knockback PIG_KNOCKBACK away, vy ≥ 5,
                                               //   mode flee for PIG_FLEE_S facing away
  raycast(ox, oy, oz, dx, dy, dz, maxDist) → { pig, distance }|null   // vertical cylinder PIG_HIT_RADIUS × PIG_HIT_HEIGHT at the feet
  export() → PigJSON[] (mm-rounded) ; load(validatedList)
  spawnNatural(count, q0, r0, seed, getBlock, isLoadedCell, minDist = 4, maxDist = 18) → placed   // grass surfaces only, seeded
}
```
AI per frame: timer expiry alternates idle (1–5 s) and walk (1.5–5.5 s, new heading within ±π); a walking, grounded pig whose
cell 0.8 ahead is liquid or has no solid ground within two cells below its feet stops and turns away. Turning is capped at
PIG_TURN_RATE; it moves forward only when within 1.2 rad of its heading, at sneak speed when walking and walk speed when fleeing,
and jumps when it hit a wall or is in water. `walkPhase` advances by 4 × horizontal distance (mod 2π); `oinkIn` resets to 6–18 s.

`createPigRenderer(scene)` → `{ sync(pigs), count(), dispose() }`: one Group per pig id, built facing −Z with `rotation.y = yaw`;
the body is a hexagonal prism (6-sided cylinder lying along Z, flat side down); legs swing with `sin(walkPhase)`; the skin
emissive is red while `hurt > 0`.

Saves: optional `pigs: PigJSON[]` (version stays 2). serializeSave writes it whenever `data.pigs` is given — EMPTY included —
after validatePigsJSON; deserializeSave keeps any validated array (warnings for dropped entries). An absent field means the world
has never had pigs: main then places PIG_NATURAL_COUNT pigs with `spawnNatural` around the spawn cell in finishLoading.

main: `updateHit` also ray-casts pigs up to the block hit's distance (or REACH); a pig in front sets `pigTarget` and clears
`hit`. `breakTargeted` hits `pigTarget` (squeal) instead of breaking. `stepPigs` runs after `stepBlackHoles`: update (with
`blackHoles.pullAt`), at most one oink per frame within 16 units (volume 1 − d/16), and pigs a black hole swallows are removed.
`renderFrame` calls `pigRenderer.sync(pigs.list)`. Commands (§26): `summon pig [q y r]` (no cell: two units ahead along the
yaw, `findFreeY` from the feet cell; refuses at PIG_MAX, unloaded targets, or 2–3 args) and `pigs [clear]`; both fail when the
context has no `pigs`. audio: `playOink(volume)`, `playSqueal(volume)`.

## 24. Test fixtures (`tests/helpers/fixtures.js`, already written)

`makeGetBlock(map, fill = AIR)` (map keyed `"q,y,r"`), `makeChunkDataGetter(chunks)` (Map keyed chunkKey → ChunkData|Chunk),
`makeChunkData()` (zeroed ChunkData), `setWorldBlock(chunks, q, y, r, id)`, `flatIsSolid(groundY)`, `flatGetBlock(groundY, id = STONE)`,
`countFaces(meshData)` (sum of `faceCount` over layers), `trivialWorldGen()` (all-AIR chunks with heights 0, biome PLAINS),
`flatWorldGen(groundY, id = STONE)`.

## 25. Pitfall checklist (read before coding)

1. Floor/mod for negatives (see §0). `-1 % 16 === -1` in JS. `hexRound` must never return −0.
2. World positions vs cell coordinates: never `Math.floor(x)` a world coordinate to get a cell — use `worldToHex(x, z)`.
3. Chunk-edge culling reads neighbours via `getChunkData`; mesh only when all 6 HEX neighbours exist (world.js); the index-space
   corner chunks `(±1, ±1)` are not neighbours — do not wait for them and do not read them.
4. AO quad flip: diagonal joins the brighter pair; do not "fix" one order by reversing it. Cap faces are fans with a centre vertex.
5. Water top: lower ALL top vertices of a water cell with non-water above (six side quads and the top hexagon).
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
