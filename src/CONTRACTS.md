# Caelancraft — Module Contracts (NORMATIVE)

Every implementer codes against this document. If `docs/SPEC-gameplay.md`, `docs/SPEC-engine.md` or
`docs/PLAN-build.md` disagree with this file on a name, path, signature, constant or convention, **this file wins**.
If you believe a contract is wrong, do NOT change it: add a `// CONTRACT-ISSUE: ...` comment at the top of your own
file explaining the problem, implement the contract as written, and move on. The integration agent adjudicates.

Plain JavaScript ES modules with JSDoc. No TypeScript. No new npm dependencies. Only `renderer.js` and `atlas.js`
import `three`. Pure modules never touch `window`, `document`, `performance` (except `world.js`, see §9), or `Math.random`.

## 0. Conventions (apply everywhere)

- Axes: +Y up. +X east, −X west, +Z south, −Z north. Block `(x,y,z)` occupies `[x,x+1)×[y,y+1)×[z,z+1)`.
- Block coordinate of a continuous position `p` is `Math.floor(p)`. Chunk of a block coordinate `w` is
  `Math.floor(w / 16)`. Local coordinate is `w - cx*16` (equivalently `w & 15`). **Never** use `%`, `|0`, `~~`,
  `Math.trunc` or `Math.round` for these — they are wrong for negatives.
- Face indices: `0:+X 1:−X 2:+Y(top) 3:−Y(bottom) 4:+Z 5:−Z`.
- Yaw/pitch: yaw rotates about +Y; **yaw = 0 faces −Z**; positive yaw turns LEFT (counter-clockwise seen from above).
  Pitch positive looks UP, clamped to ±`PITCH_LIMIT`. Camera: `rotation.order = 'YXZ'`, `rotation.set(pitch, yaw, 0)`.
- Chunk = 16 (X) × 128 (Y) × 16 (Z). Block ids are integers 0..255 in a `Uint8Array`. `0` is AIR.
- Chunk key: the string `` `${cx},${cz}` ``.
- Local index: `localIndex(lx, ly, lz) = (lx * 16 + lz) * 128 + ly` (Y innermost; a column is a contiguous run).
- Per-column arrays (biomes, heights) use index `lx * 16 + lz`.
- Texture atlas: 256×256 px, 16×16 tiles of 16 px. Tile `t` is at pixel `((t % 16) * 16, Math.floor(t / 16) * 16)`.
  `texture.flipY = false`, so UV `v` grows DOWN the image: `v0 = top of tile image`.
- Time of day `t ∈ [0,1)`: 0 = midnight, 0.25 = 06:00, 0.5 = noon, 0.75 = 18:00.
- Distances in blocks (metres), time in seconds, angles in radians. Colours handed between modules are `[r,g,b]`
  floats 0..1 in sRGB unless stated.
- Every function that receives world block coordinates accepts negatives.

## 1. Files and ownership

| File | Kind | Owner | Test file |
|---|---|---|---|
| `src/config.js` | PURE, constants | Wave 0 (done) | `tests/unit/wave0.test.js` |
| `src/types.js` | PURE, JSDoc typedefs only | Wave 0 (done) | — |
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
| `src/atlas.js` | DOM + three | A-atlas | — |
| `src/renderer.js` | three | A-renderer | — |
| `src/controls.js` | DOM | A-controls | — |
| `src/hud.js` | DOM | A-hud | — |
| `src/menus.js` | DOM | A-menus | — |
| `src/audio.js` | DOM (WebAudio) | A-audio | — |
| `src/diagnostics.js` | DOM | A-diagnostics | — |
| `src/main.js` | DOM glue | A-main | `tests/integration/harness.test.js` |
| `tests/helpers/fixtures.js` | test helpers | Wave 0 (done) | — |

Import graph (must stay acyclic):
```
config, types, noise, tiles        → (nothing)
coords                             → config
blocks                             → config, coords
chunk                              → config, coords
daynight                           → config, noise
raycast                            → config, coords, blocks
physics                            → config, coords, blocks
mesher                             → config, coords, blocks
worldgen                           → config, coords, blocks, noise
world                              → config, coords, blocks, chunk, noise (normalizeSeed), worldgen, mesher
storage                            → config, blocks (DEFAULT_HOTBAR)
atlas                              → config, blocks, tiles, three
renderer                           → config, three
controls                           → config
hud                                → config, blocks, atlas
menus                              → config, blocks, atlas
audio                              → blocks
diagnostics                        → config, blocks, coords
main                               → everything except three
```

## 2. `src/config.js` (exact — already written; do not edit)

See the file. Names used below: `CHUNK_SIZE, WORLD_HEIGHT, CHUNK_AREA, CHUNK_VOLUME, SEA_LEVEL, MIN_TERRAIN_HEIGHT,
MAX_TERRAIN_HEIGHT, RENDER_DISTANCE, DATA_RADIUS_EXTRA, UNLOAD_RADIUS_EXTRA, BUILD_BUDGET_MS, MAX_BUILDS_PER_UPDATE,
LOADING_BUDGET_MS, REACH, BREAK_REPEAT_S, PLACE_REPEAT_S, ATLAS_TILE_PX, ATLAS_TILES_PER_ROW, ATLAS_SIZE_PX, TILE_UV,
UV_INSET, WATER_SURFACE_HEIGHT, AO_CURVE, FACE_SHADE, PLAYER_WIDTH, PLAYER_HEIGHT, EYE_HEIGHT, SNEAK_EYE_HEIGHT,
GRAVITY, JUMP_VELOCITY, TERMINAL_VELOCITY, WALK_SPEED, SPRINT_SPEED, SNEAK_SPEED, FLY_SPEED, FLY_SPRINT_SPEED,
FLY_VERTICAL_SPEED, GROUND_ACCEL, AIR_ACCEL, WATER_ACCEL, WATER_GRAVITY, WATER_MAX_SINK, SWIM_UP_SPEED,
SWIM_EXIT_JUMP, WATER_SPEED_FACTOR, MAX_SUBSTEP_DT, MAX_FRAME_DT, COLLISION_EPS, FOV, SPRINT_FOV, CAMERA_NEAR,
CAMERA_FAR, MOUSE_SENSITIVITY, PITCH_LIMIT, MAX_PIXEL_RATIO, DOUBLE_TAP_MS, DOUBLE_TAP_SPACE_MS, DAY_LENGTH_SECONDS,
START_TIME, AUTOSAVE_INTERVAL_S, HOTBAR_SIZE, VERSION`.

## 3. `src/types.js` (exact — already written)

Typedefs: `BlockId, ChunkKey, FaceIndex, RenderLayer, Vec3, GetBlockFn, ChunkData, GetChunkDataFn, MeshData,
ChunkMeshData, RaycastHit, ColumnInfo, WorldGen, PlayerState, PlayerInput, SkyState, EditsJSON, SaveData,
SmokeResult, GameContext`. Import in JSDoc as `/** @typedef {import('./types.js').MeshData} MeshData */`.

## 4. `src/coords.js` (exact — already written)

`floorDiv(a,n)`, `mod(a,n)`, `worldToChunk(w)`, `worldToLocal(w)`, `chunkKey(cx,cz)`, `parseChunkKey(key)`,
`localIndex(lx,ly,lz)`, `indexToLocal(index)`, `columnIndex(lx,lz)`, `inHeightRange(y)`,
`FACE_PX..FACE_NZ`, `FACE_NORMALS`, `FACE_OPPOSITE`, `FACE_AXIS`, `FACE_TANGENTS`, `FACE_VERTS`,
`yawToForward(yaw) → [fx,fz] = [-sin, -cos]`, `yawToRight(yaw) → [cos, -sin]`,
`lookDirection(yaw,pitch) → [-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch)]`.

`FACE_VERTS[f]` lists the 4 unit-cube corners of face `f`, CCW seen from OUTSIDE, in order
bottom-left, bottom-right, top-right, top-left (where "up" = +Y for side faces and −Z for ±Y faces).

## 5. `src/blocks.js` (exact — already written)

Block ids (`BLOCK.*`): `AIR 0, STONE 1, GRASS_BLOCK 2, DIRT 3, COBBLESTONE 4, OAK_PLANKS 5, BEDROCK 6, WATER 7,
SAND 8, GRAVEL 9, OAK_LOG 10, OAK_LEAVES 11, GLASS 12, COAL_ORE 13, IRON_ORE 14, GOLD_ORE 15, DIAMOND_ORE 16,
SANDSTONE 17, SNOW_BLOCK 18, SNOWY_GRASS 19, BRICKS 20, BOOKSHELF 21, STONE_BRICKS 22, WOOL_WHITE 23, WOOL_RED 24`.
`BLOCK_COUNT = 25`.

Tile ids (`TILE.*`): `STONE 0, DIRT 1, GRASS_TOP 2, GRASS_SIDE 3, COBBLESTONE 4, OAK_PLANKS 5, BEDROCK 6, WATER 7,
SAND 8, GRAVEL 9, OAK_LOG_SIDE 10, OAK_LOG_END 11, OAK_LEAVES 12, GLASS 13, COAL_ORE 14, IRON_ORE 15, GOLD_ORE 16,
DIAMOND_ORE 17, SANDSTONE_TOP 18, SANDSTONE_SIDE 19, SNOW 20, SNOWY_GRASS_SIDE 21, BRICKS 22, BOOKSHELF 23,
STONE_BRICKS 24, WOOL_WHITE 25, WOOL_RED 26, MISSING 255`. `TILE_IDS` = array of all 28 tile ids.

Layers: `LAYER_OPAQUE 0` (everything else), `LAYER_CUTOUT 1` (OAK_LEAVES, GLASS), `LAYER_TRANSLUCENT 2` (WATER).

Biomes: `BIOME.OCEAN 0, BEACH 1, PLAINS 2, FOREST 3, DESERT 4, SNOWY 5, MOUNTAINS 6, SNOWY_PEAKS 7`, `BIOME_NAMES`.

`BLOCKS[id]` → `{ id, name, displayName, tiles:[6], solid, opaque, liquid, breakable, placeable, cullSame, layer, soundGroup }`.
Functions: `getBlockDef(id)` (unknown → the AIR def), `isSolid, isOpaque, isLiquid, isBreakable, isPlaceable,
isReplaceable (AIR or liquid), isTargetable (not AIR and not liquid), getRenderLayer, getFaceTile(id, face),
shouldRenderFace(a, b), tileToUV(tile) → [u0, v0, u1, v1]`.
Constants: `DEFAULT_HOTBAR` (9 ids), `PICKER_ORDER` (23 placeable ids), `SOUND_GROUPS`.

Culling rule (`shouldRenderFace(a, b)`, `a` = this block, `b` = neighbour in the face direction):
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
  constructor(cx, cz, data)   // data: ChunkData; arrays adopted, not copied. Missing data → zero-filled arrays.
  cx; cz; key;                // key = chunkKey(cx, cz)
  blocks; biomes; heights;    // Uint8Array(CHUNK_VOLUME), Uint8Array(CHUNK_AREA), Uint8Array(CHUNK_AREA)
  dirty = true;               // needs (re)meshing
  meshed = false;             // has been handed to the renderer at least once
  get(lx, ly, lz)             // BlockId; returns AIR (0) when out of range
  set(lx, ly, lz, id)         // returns true iff the value changed (then dirty = true); false when out of range
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
/** @typedef {{ seed:number, getColumn(wx,wz):ColumnInfo, generateChunk(cx,cz):ChunkData }} WorldGen */
/** @typedef {{ height:number, biome:number, temperature:number, humidity:number }} ColumnInfo */
export const TREE_CELL = 6;
export const TREE_DENSITY = [0, 0, 0.06, 0.7, 0, 0.06, 0, 0];   // index = BIOME id
export const ORE_TABLE = [ /* see below */ ];
```
`seed` is normalised with `normalizeSeed`. Internal noise instances use derived seeds `hash3(seed, salt, 0, 0)`,
salts 1..8: `nCont, nDetail, nMount, nTemp, nHumid, nCaveA, nCaveB, nCavern`.

### 8.1 `getColumn(wx, wz)` — pure per column. All chunk decisions that must agree across chunk borders
(trees, spawn) depend ONLY on this function.
```
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
### 8.2 `generateChunk(cx, cz)` → fresh `ChunkData` (never reuses arrays). Steps, in order:
1. **Columns.** For each `lx, lz`: `wx = cx*16+lx, wz = cz*16+lz`, `col = getColumn(wx,wz)`; `heights[ci] = col.height`,
   `biomes[ci] = col.biome` (`ci = columnIndex(lx,lz)`). Fill `y = 0..height`:
   - `y === 0` → BEDROCK; `y === 1` → BEDROCK if `rand3(wx,1,wz,seed) < 0.5`; `y === 2` → BEDROCK if `rand3(wx,2,wz,seed) < 0.15`.
   - top block (`y === height`) and filler (`height-fillerDepth <= y < height`) by biome:
     OCEAN: top/filler = `height >= 58 ? SAND : GRAVEL`, depth 3. BEACH: SAND, depth 3. PLAINS/FOREST: top GRASS_BLOCK,
     filler DIRT depth `3 + (hash2(wx,wz,seed) & 1)`. SNOWY: top SNOWY_GRASS, filler DIRT depth 3. DESERT: top SAND,
     filler SAND depth 3, then SANDSTONE for the next 3 blocks below the sand. MOUNTAINS: STONE everywhere.
     SNOWY_PEAKS: top SNOW_BLOCK, STONE below. Everything else STONE.
   - Then `y = height+1 .. SEA_LEVEL` → WATER (only when `height < SEA_LEVEL`).
2. **Caves.** For each column, `y = 6 .. height-4` (inclusive), skipping `y > SEA_LEVEL-12` when biome is OCEAN or BEACH:
   `a = nCaveA.noise3D(wx/40, y/28, wz/40)`, `b = nCaveB.noise3D(wx/40 + 300, y/28, wz/40 − 300)`,
   `taper = y < 12 ? (y-6)/6 : 1`. Carve (set AIR) if `|a| < 0.12*taper && |b| < 0.12*taper`, or if
   `y < 45 && nCavern.fbm3D(wx/70, y/50, wz/70, 2) > 0.55`. Never carve BEDROCK.
3. **Ores.** `ORE_TABLE = [ {id:COAL_ORE, attempts:18, minY:8, maxY:100, minSize:6, maxSize:10},
   {id:IRON_ORE, attempts:12, minY:4, maxY:60, minSize:4, maxSize:8}, {id:GOLD_ORE, attempts:3, minY:4, maxY:30, minSize:3, maxSize:6},
   {id:DIAMOND_ORE, attempts:1, minY:2, maxY:14, minSize:2, maxSize:5}, {id:GRAVEL, attempts:4, minY:8, maxY:70, minSize:10, maxSize:16},
   {id:DIRT, attempts:6, minY:8, maxY:90, minSize:10, maxSize:16} ]`.
   For table row `o` (index `oi`) and attempt `i`: `rng = mulberry32(hash3(cx, cz, oi*1000 + i, seed))`;
   origin `lx = floor(rng()*16), lz = floor(rng()*16), y = minY + floor(rng()*(maxY-minY+1))`; `size = minSize + floor(rng()*(maxSize-minSize+1))`;
   random walk `size` steps, each step ±1 on axis `floor(rng()*3)` (direction `rng() < 0.5 ? -1 : 1`); at every visited
   cell inside this chunk with `0 <= y < WORLD_HEIGHT`, if the block is STONE set `o.id`.
4. **Trees.** For `kx = floorDiv(cx*16 - 3, TREE_CELL) .. floorDiv(cx*16 + 18, TREE_CELL)` and same for `kz`:
   `hsh = hash2(kx, kz, seed ^ 0x7ee5)`; `tx = kx*6 + 1 + (hsh & 3)`; `tz = kz*6 + 1 + ((hsh >>> 2) & 3)`;
   `trunk = 4 + ((hsh >>> 4) % 3)`; `roll = ((hsh >>> 8) & 0xffff) / 65536`; `col = getColumn(tx, tz)`.
   Valid iff `roll < TREE_DENSITY[col.biome] && col.height >= SEA_LEVEL + 2 && col.height + trunk + 2 < WORLD_HEIGHT`.
   Stamp (only cells inside this chunk; convert world → local): with `base = col.height + 1`, `T = col.height + trunk`:
   OAK_LOG at `(tx, y, tz)` for `y = base..T` (overwrites anything); OAK_LEAVES where the cell is AIR at:
   `y ∈ {T-1, T}`: all `|dx| <= 2, |dz| <= 2` except the four corners `|dx| == 2 && |dz| == 2`;
   `y = T+1`: `|dx| <= 1, |dz| <= 1`; `y = T+2`: `|dx| + |dz| <= 1`.
   Because caves never carve above `height-4` and ores only replace STONE, every chunk agrees on every tree.

Cost target: ≤ 8 ms per chunk in Node on this machine.

## 9. `src/world.js`

```js
export class World {
  constructor(opts)   // { seed: string|number, renderDistance?: number = RENDER_DISTANCE, edits?: EditsJSON,
                      //   worldGen?: WorldGen (tests inject a trivial one), now?: () => number (ms clock; default performance.now) }
  seed;               // normalised uint32
  renderDistance;
  worldGen;           // WorldGen
  chunks;             // Map<ChunkKey, Chunk>
  edits;              // Map<ChunkKey, Map<number, BlockId>>  (inner key = localIndex)
  editVersion = 0;    // incremented on every successful setBlock (autosave uses it)
  onChunkMesh   = (key, cx, cz, meshData) => {};   // assignable hook, called synchronously from update()
  onChunkUnload = (key) => {};                     // assignable hook
  getBlock = (wx, wy, wz) => BlockId;   // ARROW PROPERTY. AIR when y out of range or chunk not loaded. Never allocates.
  getChunkData = (cx, cz) => Chunk|null; // ARROW PROPERTY.
  setBlock(wx, wy, wz, id)   // boolean: false if y out of range, chunk not loaded, or value unchanged.
                             // On success: chunk.set, edits record, editVersion++, and marks dirty every LOADED chunk
                             // containing (wx+dx, wz+dz) for dx,dz ∈ {-1,0,1} (dedupes to 1–4 chunks).
  getChunk(cx, cz)           // Chunk|undefined
  hasChunkAt(wx, wz)         // boolean
  isReadyAt(wx, wz)          // chunk exists, !dirty, meshed
  get chunkCount()           // number of loaded chunks
  update(px, pz, budgetMs = BUILD_BUDGET_MS)  // streaming step; returns { generated, meshed, unloaded, pendingGen, pendingMesh }
  findSpawn()                // Vec3: spiral from (0,0) in 4-block steps until worldGen.getColumn(x,z) has
                             // height >= SEA_LEVEL+2 and biome not OCEAN/BEACH; returns [x+0.5, height+1, z+0.5].
                             // Bounded: after 128 rings fall back to [0.5, max(getColumn(0,0).height, SEA_LEVEL)+1, 0.5]
  getSurfaceHeight(wx, wz)   // worldGen.getColumn(...).height (ignores edits)
  getBiome(wx, wz)           // biome id from worldGen.getColumn
  exportEdits()              // EditsJSON: { "cx,cz": [localIndex, id, localIndex, id, ...] }
  importEdits(editsJson)     // merge (last write wins); for loaded chunks also apply and mark dirty
  setRenderDistance(n)       // clamp 1..16, recompute ring offsets
  dispose()                  // remove all chunks, firing onChunkUnload for meshed ones
}
```
### 9.1 `update(px, pz, budgetMs)` (normative)
```
pcx = floor(px/16), pcz = floor(pz/16); start = now(); builds = 0
overBudget = () => builds >= MAX_BUILDS_PER_UPDATE || now() - start >= budgetMs
1. Unload every chunk with max(|cx-pcx|, |cz-pcz|) > renderDistance + UNLOAD_RADIUS_EXTRA:
   chunks.delete(key); if chunk.meshed → onChunkUnload(key). (Edits stay in `edits`.)
2. Re-mesh edited chunks: every loaded chunk with dirty && meshed && all 8 neighbours loaded → mesh now (ignores budget).
3. Walk RING_OFFSETS = all (dx,dz) with max(|dx|,|dz|) <= renderDistance + DATA_RADIUS_EXTRA, sorted by dx²+dz² ascending
   (ties: dz then dx ascending). For each: cx = pcx+dx, cz = pcz+dz, chunk = chunks.get(key):
   if !chunk: data = worldGen.generateChunk(cx,cz); chunk = new Chunk(cx,cz,data); apply edits.get(key) (chunk.set per pair);
              chunks.set(key, chunk); builds++; generated++; if overBudget() break
   if max(|dx|,|dz|) <= renderDistance && chunk.dirty && all 8 neighbours loaded:
              m = buildChunkMesh(cx, cz, this.getChunkData); chunk.dirty = false; chunk.meshed = true;
              onChunkMesh(key, cx, cz, m); builds++; meshed++; if overBudget() break
   pendingGen / pendingMesh = counts of remaining ring entries that still need work (computed cheaply at the end or as the walk proceeds).
```
Guarantee: at least one build per call when work is pending (budget is checked after each build). With `budgetMs = Infinity`
and `MAX_BUILDS_PER_UPDATE` respected, repeated calls converge to `pendingGen === 0 && pendingMesh === 0`.
Because a chunk is meshed only once all 8 neighbours exist, generation never invalidates an existing mesh.
Missing `performance` (Node < 16) → use `Date.now`. Tests pass `now: () => 0` and `budgetMs = Infinity`.

## 10. `src/mesher.js`

```js
export function buildChunkMesh(cx, cz, getChunkData)   // → ChunkMeshData { opaque, cutout, translucent } (null layer when 0 faces)
export function vertexAO(side1, side2, corner)          // (side1 && side2) ? 0 : 3 - (side1 + side2 + corner); args 0|1
export function createMeshBuilder()                     // internal growable buffer helper; exported for tests (optional)
/** MeshData = { positions: Float32Array (3/vertex, chunk-LOCAL: x∈[0,16], y∈[0,128], z∈[0,16]), normals: Float32Array (3/vertex),
 *   uvs: Float32Array (2/vertex), colors: Float32Array (3/vertex, 0..1), indices: Uint32Array (6/quad), vertexCount, faceCount } */
```
### 10.1 Padded volume (normative so tests agree)
`padded = Uint8Array(18*18*WORLD_HEIGHT)`, `pIndex(px,py,pz) = (px*18 + pz)*WORLD_HEIGHT + py`; local `(lx,ly,lz)` ↔ padded
`(lx+1, ly, lz+1)`. Fill: for `px,pz ∈ [0,18)`: source chunk `(cx + floorDiv(px-1,16), cz + floorDiv(pz-1,16))`, source local
`(mod(px-1,16), mod(pz-1,16))`; if `getChunkData` returns null → zeros (AIR); else copy the whole column with `subarray`.
Lookup `P(px,py,pz)`: `py < 0 → BEDROCK` (so y=0 bottoms are culled), `py >= WORLD_HEIGHT → AIR`, else `padded[...]`.
Reuse one module-level scratch buffer between calls (fill with 0 first).
### 10.2 Emission for block `a` at local `(lx,ly,lz)`, face `f`, with `N = FACE_NORMALS[f]`, `[T1,T2] = FACE_TANGENTS[f]`, neighbour `Q = P + N`:
Emit iff `shouldRenderFace(a, P(Q))`.
1. `topY = (a === WATER && P(lx+1, ly+1, lz+1) !== WATER) ? WATER_SURFACE_HEIGHT : 1`. Applies to EVERY face of that water block:
   any corner with `corner.y === 1` uses `ly + topY`.
2. For each vertex `v = 0..3`, `corner = FACE_VERTS[f][v]`: `d1 = corner[T1] ? 1 : -1`, `d2 = corner[T2] ? 1 : -1`;
   `s1 = isOpaque(P at Q + d1*E[T1])`, `s2 = isOpaque(P at Q + d2*E[T2])`, `c = isOpaque(P at Q + d1*E[T1] + d2*E[T2])`
   (`E[0]=(1,0,0), E[1]=(0,1,0), E[2]=(0,0,1)`); `ao[v] = vertexAO(s1?1:0, s2?1:0, c?1:0)`.
3. Position `(lx + corner.x, ly + (corner.y ? topY : 0), lz + corner.z)`; normal `N`.
4. UV: `[u0,v0,u1,v1] = tileToUV(getFaceTile(a,f))`; `uv[0]=(u0,v1), uv[1]=(u1,v1), uv[2]=(u1,v0), uv[3]=(u0,v0)`.
5. Colour: `shade = FACE_SHADE[f] * AO_CURVE[ao[v]]` → `(shade, shade, shade)`. (No biome tint in v1.)
6. Indices with `b = vertexCount before this quad`: if `ao[0] + ao[2] >= ao[1] + ao[3]` push `b,b+1,b+2, b,b+2,b+3`
   else push `b+1,b+2,b+3, b+1,b+3,b`. (Diagonal joins the brighter pair; both orders are CCW.)
7. Append to layer `getRenderLayer(a)`.
Build with growable JS arrays or a growable typed buffer; convert once at the end. Never throws; empty chunk → all three null.
Perf target: a real worldgen chunk in ≤ 25 ms in Node.

## 11. `src/raycast.js`

```js
export function raycastVoxel(getBlock, ox, oy, oz, dx, dy, dz, maxDistance, isHit = isTargetable)  // → RaycastHit|null
/** RaycastHit = { x, y, z (integers), face: FaceIndex|-1, nx, ny, nz, distance, blockId } */
```
Direction normalised internally (zero vector → null). Start cell `x=floor(ox)…`. If `isHit(getBlock(x,y,z))` at the start
→ `{x,y,z, face:-1, nx:0,ny:0,nz:0, distance:0, blockId}`. Amanatides–Woo: `step = sign(d)`, `tDelta = |1/d|` (Infinity if 0),
`tMax = d>0 ? (cell+1-o)/d : d<0 ? (cell-o)/d : Infinity`. Loop: choose axis with the smallest `tMax`
(**tie-break: x, then y, then z**); `t = tMax[axis]`; if `t > maxDistance` → null; advance cell, `tMax += tDelta`;
entered face = `step > 0 ? FACE_N<axis> : FACE_P<axis>` (normal = −step on that axis); if `isHit(getBlock(...))` →
hit with `distance = t`. Return null early if `y < 0 && stepY <= 0` or `y >= WORLD_HEIGHT && stepY >= 0`. Iteration cap `ceil(maxDistance*3)+3`.

## 12. `src/physics.js`

```js
export function createPlayer(x, y, z)                 // PlayerState at feet position; velocities 0; onGround false; flying false
export function stepPlayer(p, input, getBlock, dt)     // mutates p. dt clamped to MAX_FRAME_DT and split into ceil(dt/MAX_SUBSTEP_DT) equal substeps
export function getEyeHeight(p)                        // (p.sneaking && !p.flying) ? SNEAK_EYE_HEIGHT : EYE_HEIGHT
export function playerAABB(p, out = {})                // {minX,minY,minZ,maxX,maxY,maxZ}: half-width PLAYER_WIDTH/2 around (x,z), y..y+PLAYER_HEIGHT
export function playerIntersectsBlock(p, bx, by, bz)   // strict overlap of AABB with [bx,bx+1)×[by,by+1)×[bz,bz+1)
export function findStandingY(getBlock, x, z, fromY)   // scan down from fromY: first y where block(y-1) solid and blocks y, y+1 not solid; null if none
/** PlayerState = { x,y,z, vx,vy,vz, onGround, flying, sneaking, sprinting, inWater, headInWater, hitWall }
 *  PlayerInput = { forward: -1|0|1, strafe: -1|0|1, jump, sneak, sprint: boolean, yaw: number } */
```
### 12.1 Substep of `h` seconds (normative)
```
1. Environment: feet = getBlock(floor(x), floor(y+0.1), floor(z)); chest = getBlock(floor(x), floor(y+1.0), floor(z))
   inWater = isLiquid(feet) || isLiquid(chest)
   eyeY = y + getEyeHeight(p); eyeCell = getBlock(floor(x), floor(eyeY), floor(z)); above = getBlock(floor(x), floor(eyeY)+1, floor(z))
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
            (SWIM_EXIT_JUMP equals the normal jump so a swimmer can climb a bank whose top is one block above the water surface)
   else:    if (jump && onGround) vy = JUMP_VELOCITY;  vy = max(vy + GRAVITY*h, TERMINAL_VELOCITY)
4. Move, axis order Y → X → Z; before moving: onGround = false, hitWall = false
   moveAxis(Y, vy*h): collision moving down → onGround = true; any collision → vy = 0
   moveAxis(X, vx*h): collision → vx = 0, hitWall = true
   moveAxis(Z, vz*h): collision → vz = 0, hitWall = true
   If flying and a downward collision happened → flying = false (landing ends flight).
```
`moveAxis(axis, delta)`: `pos[axis] += delta`; compute AABB; iterate cells `floor(min) .. ceil(max)-1` on all three axes and
collect cells with `isSolid(getBlock(...))`. If any: `delta > 0` → `pos[axis] = min(cellMin[axis]) - extent - COLLISION_EPS`;
`delta < 0` → `pos[axis] = max(cellMax[axis]) + extentNeg + COLLISION_EPS`, where for X/Z `extent = extentNeg = PLAYER_WIDTH/2`,
for Y `extent = PLAYER_HEIGHT`, `extentNeg = 0`. Non-finite state → reset velocities to 0 and `console.warn` once.
Sneak edge-prevention is NOT implemented in v1.

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
export const SAVE_KEY = 'caelancraft:v1:save';
export const SAVE_VERSION = 1;
export function serializeSave(data)                 // SaveData → JSON string (keys in stable order)
export function deserializeSave(text)               // string → SaveData|null (null on parse error, wrong version, missing/invalid fields)
export function saveGame(data, storage = globalThis.localStorage)   // boolean; false when storage missing or setItem throws
export function loadGame(storage = globalThis.localStorage)         // SaveData|null
export function hasSave(storage = globalThis.localStorage)          // boolean
export function clearSave(storage = globalThis.localStorage)        // void
/** SaveData = { version: 1, seed: number, time: number, day: number, player: {x,y,z,yaw,pitch,flying}, hotbar: number[9],
 *   selected: number, edits: EditsJSON }   EditsJSON = { "cx,cz": [localIndex, id, localIndex, id, ...] } */
```
Validation on load: each edits entry must be an even-length array of integers with `0 <= localIndex < CHUNK_VOLUME` and
`0 <= id <= 255`; invalid pairs are dropped (count them in a `warnings` array attached as a non-enumerable property is optional).
`hotbar` must be 9 integers, `selected` 0..8, else defaults.

## 15. `src/tiles.js` (pure pixel painters)

```js
export const TILE_NAMES = { 0:'stone', 1:'dirt', ..., 26:'wool_red', 255:'missing' };   // matches TILE in blocks.js
export function paintTile(tile)          // → Uint8ClampedArray(16*16*4), RGBA, idx = (y*16 + x)*4. Deterministic. Unknown tile → 'missing' checker.
export function averageColor(tile)       // → [r,g,b] 0..255 mean over pixels with alpha >= 128
export function createTilePainters()     // → Map<tile, () => Uint8ClampedArray> (optional convenience)
```
Recipes: `docs/SPEC-gameplay.md` §2.3–§2.4 verbatim, including the alpha rules (water alpha 178 everywhere; glass interior
alpha 0 with opaque frame; leaves ~22% alpha-0 holes; everything else alpha 255). Use private copies of `mulberry32` and
`fnv1a` (do not import noise.js). `paintTile` never depends on the world seed.

## 16. `src/atlas.js` (DOM + three)

```js
export function createAtlasCanvas()                        // 256×256 canvas; every id in TILE_IDS painted via paintTile at its tile origin
export function createAtlasTexture(canvas)                 // THREE.CanvasTexture: magFilter = minFilter = NearestFilter, generateMipmaps = false,
                                                           //   flipY = false, colorSpace = SRGBColorSpace, wrapS/T = ClampToEdgeWrapping, needsUpdate = true
export function drawBlockIcon(ctx, atlasCanvas, blockId, size)   // isometric cube icon (docs/SPEC-gameplay.md §2.5) scaled to size×size at (0,0)
export function makeBlockIconCanvas(atlasCanvas, blockId, size)  // new canvas with the icon
export function makeTiledBackgroundDataURL(atlasCanvas, tile, repeats = 4)   // PNG data URL of tile repeated repeats×repeats
export function drawTitleLogo(logoCanvas, atlasCanvas)     // "Caelancraft" stone-pattern text per SPEC-gameplay §5.3
export function makeSunCanvas()                            // 32×32 per §2.5
export function makeMoonCanvas()
```

## 17. `src/renderer.js` (three)

```js
export function createRenderer(canvas, atlasTexture, opts = {})   // opts: { sunCanvas?, moonCanvas?, renderDistance? }
/** Renderer = {
 *  three: { renderer, scene, camera },
 *  setChunkMesh(key, cx, cz, meshData: ChunkMeshData),  // replaces existing meshes for key; null layers → no mesh. Geometry from typed arrays,
 *                                                       //   mesh.position = (cx*16, 0, cz*16), matrixAutoUpdate=false + updateMatrix(), computeBoundingSphere()
 *  removeChunkMesh(key),                                // no-op if unknown; scene.remove + geometry.dispose() (never dispose shared materials)
 *  setCamera(x, y, z, yaw, pitch),                      // eye position; rotation.order 'YXZ'; rotation.set(pitch, yaw, 0)
 *  setFov(fov),                                         // updates projection when changed
 *  setHighlight(hit: RaycastHit|null),                  // black wireframe box 1.002 at block centre; hidden when null or face === -1 is fine to show
 *  setSky(sky: SkyState),                               // lights, background/sky dome, fog colours
 *  setUnderwater(on),                                   // fog near 1 / far 22 colour #204A8C when on; normal fog otherwise
 *  setRenderDistance(chunks),                           // fog far = (chunks - 0.5)*16, near = far*0.55
 *  resize(width, height),
 *  render(),
 *  getStats(),                                          // { chunkMeshes, triangles, drawCalls, geometries }
 *  dispose() } */
```
Wiring: `new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' })`; `setPixelRatio(min(devicePixelRatio, MAX_PIXEL_RATIO))`;
`setSize(w, h, false)`. Leave `outputColorSpace` default. Three shared materials:
`opaque = MeshLambertMaterial({ map, vertexColors: true })`, `cutout = MeshLambertMaterial({ map, vertexColors: true, alphaTest: 0.5, side: DoubleSide })`,
`translucent = MeshLambertMaterial({ map, vertexColors: true, transparent: true, depthWrite: false, side: DoubleSide })` (renderOrder 1).
Lights: `DirectionalLight` (position = sunDir*200, target origin), `HemisphereLight(horizon, ground)`. `setSky`: `dir.intensity = sunIntensity`,
`dir.color.setRGB(...sunColor, SRGBColorSpace)`, `hemi.intensity = hemiIntensity`, fog/background via `setRGB(..., SRGBColorSpace)`.
Sky: `SphereGeometry(500,16,8)` BackSide dome with the gradient shader from SPEC-gameplay §6 following the camera (uniforms zenith/horizon), `fog: false`,
`depthWrite: false`, `renderOrder -3`. Sun/moon sprites: keep §6's depthTest:false / depthWrite:false / fog:false / renderOrder −1 but set `transparent: false, alphaTest: 0.5` so they render in the OPAQUE pass before terrain, which then overdraws them (the sun sets behind hills). Stars per §6. Fog: `new Fog(color, near, far)`.
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
Clear held keys on unlock and on `window blur`. `keydown` for game keys calls `preventDefault()` while locked (Space, Tab, F3, digits, WASD, Shift).
Digit keys 1–9 are read by main via `consumePressed('Digit1')`. Do not bind Ctrl.

## 19. `src/hud.js` (DOM)

```js
export function createHUD(doc, atlasCanvas)   // binds to the ids in index.html (#hud, #crosshair, #hotbar, #block-toast, #save-toast, #debug-overlay, #underwater-overlay, #error-banner)
/** HUD = {
 *  setHotbar(ids: number[9], selected),   // redraws slot icons (drawBlockIcon at 32px; AIR → blank) and selection
 *  setSelected(i),
 *  showBlockToast(text),                   // 1.5 s then .fade 0.3 s then .hidden; restarts timer
 *  setDebugText(text), setDebugVisible(on), toggleDebug(), isDebugVisible(),
 *  setUnderwater(on),
 *  showSaveToast(text, isError = false),   // 1.5 s
 *  showError(text),                        // appends a line to #error-banner and unhides it
 *  setPickerOpen(on),                      // toggles #hud.picker-open
 *  onSlotClick: (slot) => {},              // assignable; fired when a hotbar slot is clicked (only while picker open)
 *  dispose() } */
```

## 20. `src/menus.js` (DOM)

```js
export const SPLASHES = [ /* 18 strings from SPEC-gameplay §5.4 */ ];
export function createMenus(doc, atlasCanvas, callbacks)
/** callbacks = { onNewWorld(seedText: string), onContinue(), onResume(), onSave(), onQuit(), onClickToPlay(), onPickBlock(blockId, slot|null), onPickerClose() }
 *  Menus = {
 *   showTitle(hasSave), hideTitle(),        // sets a random splash, dirt background (makeTiledBackgroundDataURL DIRT), draws the logo, renders the controls sheet, enables #btn-continue iff hasSave
 *   showLoading(done, total), hideLoading(),
 *   showClickToPlay(), hideClickToPlay(),
 *   showPause(seed), hidePause(),
 *   showPicker(hotbar, selected), hidePicker(), isPickerOpen(),   // grid of PICKER_ORDER icons (64px); click → onPickBlock(id, null); Digit1-9 while hovering → onPickBlock(id, slot)
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
export function parseParams(search = location.search)   // → Params { seed: string|null, rd: number|null (1..16), smoke, autoplay, nosave, debug, fly: boolean, time: number|null }
export function installErrorCapture(win, onError)        // window 'error' + 'unhandledrejection' → onError({message, stack})
export function installDebugHandle(win, game)            // win.__caelancraft = { version, ready:false, seed, world, player, controls, renderer, stats, errors:[], smoke:null, getBlock, setBlock, teleport, setTime }
export function updateDebugHandle(win, stats)            // refresh stats + ready flag (called by main every ~250 ms)
export function buildDebugText(game, stats)              // the F3 text block from SPEC-gameplay §5.5
export function runSmokeTest(game, win = window)         // Promise<SmokeResult>; drives the sequence in docs/PLAN-build.md §4, sets win.__caelancraft.smoke,
                                                         // console.log('SMOKE_OK'|'SMOKE_FAIL', JSON), writes #smoke-result (created if missing) and a green/red banner
/** GameContext (types.js) = { world, player, controls, renderer, hud, getTime(), setTime(t), getHit(), breakTargeted() → boolean, placeSelected() → boolean,
 *   teleport(x,y,z), setLook(yaw,pitch), getState() → 'title'|'loading'|'clickToPlay'|'playing'|'paused'|'picker', stepFrame?(dt) } */
```

## 23. `src/main.js` (glue; owns the game loop)

Boot: `params = parseParams()`; `save = params.nosave ? null : loadGame()`; DOM handles; `atlasCanvas`, `atlasTexture`, `renderer`, `hud`, `menus`, `controls`, `audio`.
State machine: `title → loading → clickToPlay → playing ⇄ paused`, `playing ⇄ picker`.
- **Title**: `menus.showTitle(hasSave)`. New World → seed from input (`normalizeSeed` on trimmed text; empty → random `Math.floor(Math.random()*2**31)`),
  clear save (if not nosave), start. Continue → start with save. `params.autoplay || params.smoke` → skip title (use `params.seed ?? save?.seed ?? random`).
- **Loading**: `world = new World({ seed, renderDistance: params.rd ?? RENDER_DISTANCE, edits: save?.edits })`; `world.onChunkMesh = renderer.setChunkMesh;
  world.onChunkUnload = renderer.removeChunkMesh`; spawn = save?.player ?? world.findSpawn(); each frame `world.update(spawn.x, spawn.z, LOADING_BUDGET_MS)`,
  show progress = meshed chunks within radius 2 of spawn out of 25; when `world.isReadyAt(spawn.x, spawn.z)` → create player (`createPlayer`, or restore),
  `controls.yaw = save?.player.yaw ?? Math.PI` (face +Z), then `clickToPlay` (or straight to `playing` when autoplay/smoke).
- **Playing** loop (`requestAnimationFrame` timestamp; `dt = min((t - last)/1000, MAX_FRAME_DT)`): `input = controls.getInput()`; handle
  `consumeFlyToggle()` → `player.flying = !player.flying; player.vy = 0`; digits/wheel → hotbar; `KeyE` → picker; `F3` → debug; `KeyM` → mute;
  mouse edges/holds → break (repeat `BREAK_REPEAT_S`) / place (repeat `PLACE_REPEAT_S`) / pick; `if (world.hasChunkAt(player.x, player.z)) stepPlayer(...)`;
  `time = advanceTime(time, dt)` (frozen when `params.time != null`); `world.update(player.x, player.z)`; eye/dir/raycast (`REACH`);
  `renderer.setCamera/setFov(sprinting ? SPRINT_FOV : FOV, smoothed)/setHighlight/setSky/setUnderwater`; HUD; `renderer.render()`; stats every 250 ms.
- **Paused**: entered when pointer lock is lost while playing (and not opening the picker); simulation and clock freeze; keep rendering. Resume re-locks.
- Break rule: `hit && isBreakable(hit.blockId)` → `world.setBlock(x,y,z,AIR)`; `audio.playBreak(group)`. Place rule: `hit && hit.face >= 0`; target = hit + normal;
  require `inHeightRange(ty)`, `isReplaceable(world.getBlock(tx,ty,tz))`, and `!(isSolid(sel) && playerIntersectsBlock(player, tx,ty,tz))`; `audio.playPlace`.
  Pick (middle): if `hit` and placeable: select the slot containing it, else assign to the selected slot.
- Autosave every `AUTOSAVE_INTERVAL_S` when `world.editVersion` changed or player moved, plus on `pagehide`, `visibilitychange(hidden)`, pause, Save, Quit. Skipped when `params.nosave`.
- Diagnostics: `installErrorCapture` → `hud.showError`; `installDebugHandle`; if `params.smoke` → `runSmokeTest(game)` once playing.
- `window.resize` → `renderer.resize(innerWidth, innerHeight)`.

## 24. Test fixtures (`tests/helpers/fixtures.js`, already written)

`makeGetBlock(map, fill = AIR)` (map keyed `"x,y,z"`), `makeChunkDataGetter(chunks)` (Map keyed chunkKey → ChunkData|Chunk),
`makeChunkData()` (zeroed ChunkData), `flatIsSolid(groundY)`, `flatGetBlock(groundY, id = STONE)`, `countFaces(meshData)`,
`trivialWorldGen()` (all-AIR chunks with heights 0, biome PLAINS), `flatWorldGen(groundY, id = STONE)`.

## 25. Pitfall checklist (read before coding)

1. Floor/mod for negatives (see §0). `-1 % 16 === -1` in JS.
2. Chunk-edge culling reads neighbours via `getChunkData`; mesh only when all 8 neighbours exist (world.js).
3. AO quad flip: diagonal joins the brighter pair; do not "fix" one order by reversing it.
4. Water top: lower ALL y=1 corners of a water block with non-water above, not just the top face.
5. Leaves and glass are cutout (`alphaTest 0.5`, depth write on). Water is the only translucent layer.
6. Texture bleeding: NearestFilter both filters, no mipmaps, `UV_INSET`.
7. `flipY = false` ⇔ the UV assignment in §10.2 step 4.
8. Colour spaces: atlas `colorSpace = SRGBColorSpace`; `Color.setRGB(r,g,b, SRGBColorSpace)` for spec colours.
9. Physical light units: no `useLegacyLights`; sun ≈ 2 at noon, hemisphere ≈ 1.4.
10. Unloading: `scene.remove` + `geometry.dispose()`; never dispose shared materials/texture.
11. Pointer lock only from a user gesture; catch promise rejections; clear key state on unlock/blur.
12. dt: clamp to `MAX_FRAME_DT`; sub-step physics; use the rAF timestamp.
13. `getBlock` returns AIR in unloaded chunks → guard physics with `world.hasChunkAt`.
14. Apply saved edits right after `generateChunk`, before the chunk is visible to `getBlock`.
15. Indices are `Uint32Array`; hand Three `new BufferAttribute(indices, 1)`.
16. Never bind Ctrl (`Ctrl+W` closes the tab). Sprint is double-tap W.
17. Column arrays use `lx*16 + lz`.
18. Tree validity depends only on `getColumn` — never on chunk block data.
