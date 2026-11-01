# Caelancraft — Gameplay, UX and Procedural Art Specification (v1)

> **v0.2 honeycomb revision.** Caelancraft's cells are now hexagonal prisms (pointy-top, 1 wide across the flats,
> addressed by axial `(q, r)` + `y`; see `src/hex.js`). Wherever this document describes cube blocks — AABBs, six
> axis-aligned faces, square chunk footprints, the Amanatides–Woo voxel walk, the isometric cube icon — the
> normative hex definitions in `src/CONTRACTS.md` supersede it. Block palette, texture recipes, terrain numbers,
> controls, HUD and day/night still apply. Saves are v2 per `src/CONTRACTS.md` §14 (single key `caelancraft:v2:save`,
> `version: 2`, edits keyed by hex chunk `"cq,cr"` with `localIndex = (lq*16 + lr)*128 + ly`; v1 saves are not loadable),
> and the loading screen waits for the hex disc of 19 chunks (`hexDiscCount(2)`) rather than a 5×5 square.

> Authoritative for: block palette, texture recipes, terrain feel numbers, controls, HUD/UI DOM+CSS,
> day/night keyframes, water behaviour, save format, break/place feel. Where this document and
> `src/CONTRACTS.md` disagree on *code-level names/paths/signatures*, `src/CONTRACTS.md` wins.

## 0. Conventions

- Minecraft coordinate convention: +Y up, **+X east, −X west, +Z south, −Z north**. World Y range `[0,127]` (WORLD_HEIGHT 128), chunk column 16×128×16. Block `(x,y,z)` occupies `[x,x+1)×[y,y+1)×[z,z+1)`.
- Face indices shared by mesher/texture lookup/raycast: `0:+X, 1:−X, 2:+Y top, 3:−Y bottom, 4:+Z, 5:−Z`.
- Player AABB 0.6 wide × 1.8 tall, eye 1.62 (sneaking 1.27), reach 5.0 blocks from the eye. Gravity 32 m/s², jump velocity 9.0 m/s (≈1.27-block jump). Base FOV 70.
- All colours sRGB hex. UI font stack: `Consolas, "Lucida Console", "Courier New", ui-monospace, monospace`.

---

## 1. Block palette

### 1.1 Table

`transparent` = neighbour faces against this block are rendered. `cullSame` = faces between two blocks of the same id are culled. `hardness` = survival seconds, **ignored in v1**.

| id | name | displayName | tiles top / bottom / side | solid | transparent | liquid | breakable | placeable | cullSame | hardness | soundGroup |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | `air` | Air | – | no | yes | no | – | no | – | – | – |
| 1 | `stone` | Stone | stone | yes | no | no | yes | yes | yes | 1.5 | stone |
| 2 | `grass_block` | Grass Block | grass_top / dirt / grass_side | yes | no | no | yes | yes | yes | 0.6 | grass |
| 3 | `dirt` | Dirt | dirt | yes | no | no | yes | yes | yes | 0.5 | dirt |
| 4 | `cobblestone` | Cobblestone | cobblestone | yes | no | no | yes | yes | yes | 2.0 | stone |
| 5 | `oak_planks` | Oak Planks | oak_planks | yes | no | no | yes | yes | yes | 2.0 | wood |
| 6 | `bedrock` | Bedrock | bedrock | yes | no | no | **no** | **no** | yes | ∞ | stone |
| 7 | `water` | Water | water | **no** | yes | **yes** | no (not targetable) | yes | yes | – | water |
| 8 | `sand` | Sand | sand | yes | no | no | yes | yes | yes | 0.5 | sand |
| 9 | `gravel` | Gravel | gravel | yes | no | no | yes | yes | yes | 0.6 | gravel |
| 10 | `oak_log` | Oak Log | oak_log_end / oak_log_end / oak_log_side | yes | no | no | yes | yes | yes | 2.0 | wood |
| 11 | `oak_leaves` | Oak Leaves | oak_leaves | yes | yes (cutout) | no | yes | yes | **no** | 0.2 | leaves |
| 12 | `glass` | Glass | glass | yes | yes (cutout) | no | yes | yes | yes | 0.3 | glass |
| 13 | `coal_ore` | Coal Ore | coal_ore | yes | no | no | yes | yes | yes | 3.0 | stone |
| 14 | `iron_ore` | Iron Ore | iron_ore | yes | no | no | yes | yes | yes | 3.0 | stone |
| 15 | `gold_ore` | Gold Ore | gold_ore | yes | no | no | yes | yes | yes | 3.0 | stone |
| 16 | `diamond_ore` | Diamond Ore | diamond_ore | yes | no | no | yes | yes | yes | 3.0 | stone |
| 17 | `sandstone` | Sandstone | sandstone_top / sandstone_top / sandstone_side | yes | no | no | yes | yes | yes | 0.8 | stone |
| 18 | `snow_block` | Snow Block | snow | yes | no | no | yes | yes | yes | 0.2 | snow |
| 19 | `snowy_grass` | Snowy Grass | snow / dirt / snowy_grass_side | yes | no | no | yes | yes | yes | 0.6 | snow |
| 20 | `bricks` | Bricks | bricks | yes | no | no | yes | yes | yes | 2.0 | stone |
| 21 | `bookshelf` | Bookshelf | oak_planks / oak_planks / bookshelf | yes | no | no | yes | yes | yes | 1.5 | wood |
| 22 | `stone_bricks` | Stone Bricks | stone_bricks | yes | no | no | yes | yes | yes | 1.5 | stone |
| 23 | `wool_white` | White Wool | wool_white | yes | no | no | yes | yes | yes | 0.8 | cloth |
| 24 | `wool_red` | Red Wool | wool_red | yes | no | no | yes | yes | yes | 0.8 | cloth |

- 24 blocks + air. **Light emission skipped in v1.**
- `bedrock` not placeable (avoids unremovable mistakes). `water` placeable as a static source; never targetable, so it is removed only by placing over it.
- soundGroups: `stone, dirt, grass, sand, gravel, wood, leaves, glass, snow, cloth, water`.

### 1.2 Face lookup
`getFaceTile(id, face)`: face 2 → `tiles.top`, face 3 → `tiles.bottom`, faces 0/1/4/5 → `tiles.side`. Logs always vertical (no rotation).

### 1.3 `src/blocks.js` exports (see CONTRACTS.md for the final signatures)
```js
export const BLOCK = { AIR:0, STONE:1, GRASS_BLOCK:2, DIRT:3, COBBLESTONE:4, OAK_PLANKS:5, BEDROCK:6, WATER:7, SAND:8, GRAVEL:9, OAK_LOG:10, OAK_LEAVES:11, GLASS:12, COAL_ORE:13, IRON_ORE:14, GOLD_ORE:15, DIAMOND_ORE:16, SANDSTONE:17, SNOW_BLOCK:18, SNOWY_GRASS:19, BRICKS:20, BOOKSHELF:21, STONE_BRICKS:22, WOOL_WHITE:23, WOOL_RED:24 };
export const BLOCKS = [/* indexed by id; fields = table columns; tiles hold TILE indices */];
export const DEFAULT_HOTBAR = [2, 3, 1, 4, 5, 10, 11, 12, 20]; // grass, dirt, stone, cobble, planks, log, leaves, glass, bricks
export const PICKER_ORDER = [1, 4, 22, 3, 2, 19, 8, 17, 9, 18, 10, 5, 11, 21, 12, 20, 23, 24, 13, 14, 15, 16, 7]; // 23 placeables
export function getFaceTile(id, face) {}
export function isSolid(id) {}  export function isTransparent(id) {}  export function isLiquid(id) {}
```

### 1.4 Break timing decision
**Instant break (creative parity).** Hold LMB auto-repeats every **250 ms**; hold RMB auto-places every **200 ms**.

---

## 2. Procedural textures

### 2.1 Atlas and sampling contract
- Tile 16×16 px; atlas 16×16 tiles = **256×256 px**. Index `i` → `col = i % 16`, `row = floor(i/16)`, pixel origin `(col*16, row*16)`.
- `THREE.CanvasTexture`: `magFilter = minFilter = NearestFilter`, `generateMipmaps = false`, `colorSpace = SRGBColorSpace`, **`flipY = false`**, `anisotropy = 1`.
- UVs with `UV_EPS = 1/4096` (¹⁄₁₆ texel; kills boundary bleed, no visible stretch): `u0 = col/16 + EPS`, `u1 = (col+1)/16 − EPS`, `v0 = row/16 + EPS`, `v1 = (row+1)/16 − EPS`. With `flipY=false`, **v0 is the top row of the tile image**: side faces put `v0` at the world-up edge. Top/bottom faces: +X → u increases, +Z → v increases.
- No padding, no mipmaps in v1.
- Materials: terrain `MeshLambertMaterial({ map, alphaTest: 0.5, vertexColors: true })` (leaves/glass cutout); water separate mesh `MeshLambertMaterial({ map, transparent: true, depthWrite: false, vertexColors: true })`.
- **Biome tint: none in v1** (single grass/leaf green; snow biome uses `snowy_grass`, desert uses sand).

### 2.2 Tile indices
| idx | tile | idx | tile |
|---|---|---|---|
| 0 | stone | 14 | coal_ore |
| 1 | dirt | 15 | iron_ore |
| 2 | grass_top | 16 | gold_ore |
| 3 | grass_side | 17 | diamond_ore |
| 4 | cobblestone | 18 | sandstone_top |
| 5 | oak_planks | 19 | sandstone_side |
| 6 | bedrock | 20 | snow |
| 7 | water | 21 | snowy_grass_side |
| 8 | sand | 22 | bricks |
| 9 | gravel | 23 | bookshelf |
| 10 | oak_log_side | 24 | stone_bricks |
| 11 | oak_log_end | 25 | wool_white |
| 12 | oak_leaves | 26 | wool_red |
| 13 | glass | 27–254 | reserved |
| | | 255 | missing (debug checker) |

### 2.3 PRNG and helpers
Recipes operate on a pure `Uint8ClampedArray(16*16*4)` (`idx = (y*16+x)*4`) so they run in Vitest under Node; the browser-side atlas builder blits with `putImageData`.

```js
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function fnv1a(s){let h=0x811c9dc5;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193);}return h>>>0;}
```
Each tile: `rng = mulberry32(fnv1a(seedName))`, seedName = tile name unless stated. Textures never depend on the world seed.

Helpers (clamp 0–255): `fill(hex)`; `set(x,y,hex,a=255)`; `noise(amp)` = per pixel `d = round((rng()*2−1)*amp)` added to R,G,B; `cellNoise(size,amp)` = one `d` per `size×size` cell; `speck(count, colors[])` = random pixels set to a random listed colour; `adj(hex,d)`; `randInt(a,b)` inclusive; `pick(list)`.

### 2.4 Recipes

- **0 stone** — `fill(#7E7E7E); cellNoise(2,14); noise(5); speck(6,[#6A6A6A])`.
- **1 dirt** — `fill(#866043); cellNoise(2,16); noise(6); speck(10,[#9B7653]); speck(6,[#5C3F2A])`.
- **2 grass_top** — `fill(#5E9E3A); cellNoise(2,18); noise(6); speck(8,[#78B84A]); speck(8,[#4A7F2C])`.
- **3 grass_side** — dirt recipe with seed `"dirt"` (pixel-identical base). Then rng `"grass_side"`: per column `h = 2 + randInt(0,2)`; rows `0..h−1` → `adj(#5E9E3A, randInt(−10,10))`; pixel `(x,h)` → `adj(pixel, −14)`.
- **4 cobblestone** — toroidal Voronoi: 9 seeds at random `(sx,sy)`, gray `g = 128 + randInt(−22,22)`. Per pixel: toroidal distance (`dx = min(|x−sx|, 16−|x−sx|)`), nearest `d1`, second `d2`. `d2−d1 < 1.2` → mortar `adj(#4A4A4A, randInt(−4,4))`; else `rgb(g,g,g)` + `randInt(−6,6)`.
- **5 oak_planks** — `fill(#A2824E)`. Plank `p = floor(y/4)`, per-plank `randInt(−8,8)` on rows `4p..4p+2`. Seam rows `3,7,11,15` → `#6E5533`. Vertical end seams (`#6E5533`, rows `4p..4p+2`) at columns `[11,3,13,6]` for planks 0–3. Per plank 3 grain streaks: random x/row, length `randInt(3,6)`, `adj(−14)`, wrap x. `noise(5)`.
- **6 bedrock** — `fill(#565656); cellNoise(2,30); noise(8); speck(8,[#2B2B2B]); speck(6,[#8E8E8E])`.
- **7 water** — `fill(#3B6FD9); cellNoise(2,12); noise(4)`; 6 horizontal ripples length 3 in `#6A9BF0` (wrap). **Alpha 178 (0.70) on every pixel.**
- **8 sand** — `fill(#DBCFA3); cellNoise(2,10); noise(5); speck(6,[#C7B98A])`.
- **9 gravel** — `fill(#7F7C7A)`; 40 pebbles `{1×1, 2×1, 1×2}` gray `randInt(94,163)` (wrap); `noise(6)`.
- **10 oak_log_side** — `fill(#6B5032)`; per column `randInt(−16,16)`; 3 cracks: random column, start `randInt(0,8)`, length `randInt(5,10)`, `#4A3620`; `noise(5)`.
- **11 oak_log_end** — `r = max(|x−7.5|, |y−7.5|)`. `r ≥ 6.5` → bark `adj(#6B5032, randInt(−10,10))`; `r ∈ {4.5, 2.5, 0.5}` → ring `#8F7345`; else wood `#AF8F5A`; `noise(6)` on non-bark.
- **12 oak_leaves** — `fill(#4A8A2C); cellNoise(2,16); noise(8); speck(12,[#6BAF3C])`; each pixel with `rng() < 0.22` → alpha 0 (keep RGB), rest alpha 255. Cutout; `cullSame=false` so canopies are not hollow.
- **13 glass** — all `rgba(255,255,255,0)`. Border (`x∈{0,15}` or `y∈{0,15}`) → `#E1EEF3` α255; corners → `#FFFFFF`. Streaks α255 `#E8F4FA`: `x+y==5` for `x∈[1,4]`; `x+y==9` for `x∈[1,8]`.
- **14–17 ores** — stone recipe with seed `"stone"`, then `oreBlobs(count, main, dark, highlight?)`: `count`× pick `(x,y)∈[1,13]`; pixels `(x,y),(x+1,y),(x,y+1)` always, `(x+1,y+1)` p0.5, `(x−1,y)` p0.35, `(x,y+2)` p0.25; each pixel `main` p0.7 else `dark`; first pixel → `highlight` if given.
  coal `6, #161616, #3B3B3B` · iron `5, #D8AF93, #B08466` · gold `5, #FCEE4B, #D4A82A` · diamond `5, #5DECF5, #2FB5C7, #E8FFFF`.
- **18 sandstone_top** — `fill(#E0D5A8); cellNoise(2,8); noise(4)`.
- **19 sandstone_side** — `fill(#D9CD9D)`; rows 0–1 `#E3D9AF`; rows 14–15 `#CDBF8B`; row 15 `#B9A874`; strata rows `5,9,13` → `#C3B27B` with p0.7 per pixel; `noise(5)`.
- **20 snow** — `fill(#F2F8F8); cellNoise(2,6); noise(3); speck(5,[#DCE6E6])`.
- **21 snowy_grass_side** — dirt recipe seed `"dirt"`; per column `h = 3 + randInt(0,1)`; rows `0..h−1` → `adj(#F2F8F8, randInt(−4,4))`; `(x,h)` → `adj(−10)`.
- **22 bricks** — band `b = floor(y/4)`, `o = (b%2)*4`. Mortar where `y%4==3` or `(x+o)%8==7` → `adj(#B4AEA5, randInt(−4,4))`; else per-brick base `adj(#965040, randInt(−10,10))` (brick id `(b, floor((x+o)/8))`), per-pixel `randInt(−5,5)`.
- **23 bookshelf** — oak_planks recipe seed `"oak_planks"` over whole tile. Shelves rows 1–6 and 9–14: fill `#2B1F14`; then `x=0; while x<16: w=pick([1,2,2,2,3]); color=pick([#B23A2E,#3B5DAA,#4E8C3A,#C8A43A,#7D4FAF,#D9D2C4,#6A4A2B]); h=pick([5,6,6]); fill cols x..min(x+w−1,15), rows (shelfTop+6−h)..shelfTop+5; rightmost col adj(−30); x+=w`.
- **24 stone_bricks** — bricks layout; mortar `adj(#4F4F4F, ±4)`; brick `adj(#7A7A7A, randInt(−12,12))`, per-pixel `±5`; 3 chips `adj(−20)`.
- **25 wool_white** — `fill(#E9ECEC)`; `(x+y)%4==0` → `adj(−14)`; `(x+y)%4==2` → `adj(+6)`; `cellNoise(2,6); noise(4)`.
- **26 wool_red** — same with base `#A12722`.
- **255 missing** — 8×8 quadrant checker `#FF00FF` / `#000000`.

### 2.5 Derived assets
- `averageColor(tileIndex)` = mean RGB of pixels with α ≥ 128 (particles).
- **Block icons**: isometric cube on a 32×32 canvas, `imageSmoothingEnabled=false`; vertices T(16,1) R(30,8) L(2,8) C(16,15) BL(2,22) BR(30,22) B(16,29). Per face `ctx.setTransform(a,b,c,d,e,f); drawImage(atlas, sx, sy, 16, 16, 0, 0, 16, 16)`:
  top(tiles.top) `setTransform(14/16, 7/16, −14/16, 7/16, 16, 1)`;
  left(tiles.side) `setTransform(14/16, 7/16, 0, 14/16, 2, 8)` then `globalCompositeOperation='source-atop'; fillStyle='rgba(0,0,0,0.20)'; fillRect(0,0,16,16)`;
  right(tiles.side) `setTransform(14/16, −7/16, 0, 14/16, 16, 15)` then darken `rgba(0,0,0,0.40)`. Reset composite op/transform between faces. Shown at 32 px (hotbar) and 64 px (picker), `image-rendering: pixelated`.
- Sun sprite 32×32: `fillRect(4,4,24,24) #FFF3A0; fillRect(7,7,18,18) #FFFBE0`. Moon: `fillRect(6,6,20,20) #DDE2F0`, 2×2 craters at (9,9),(17,12),(12,19) `#B4BCD2`.
- Title/loading background: dirt tile ×4 into 64×64 canvas → `toDataURL()` → CSS background, tiled `64px 64px`.

---

## 3. Terrain feel

### 3.1 Constants
`SEA_LEVEL = 62` (top water block y=62, surface at 62.875). Bedrock: y=0 always, y=1 p0.5, y=2 p0.15 (`hash3(seed,x,y,z)`). Height cap 120. Target histogram: ~15% ocean (h<60), ~55% lowland 63–75, ~20% hills 75–90, ~10% mountain >90.

### 3.2 Height (fbm lacunarity 2, gain 0.5, outputs in [−1,1])
`c = fbm2(x*0.002, z*0.002, 3)`; `d = fbm2(x*0.02, z*0.02, 2)`; `m = clamp((fbm2(x*0.004, z*0.004, 2) − 0.25)/0.75, 0, 1)`;
`h = round(66 + c*14 + d*4 + m*m*48)` clamped `[40,120]`. Desert: `h = round(66 + c*10 + d*2 + m*m*48)`.

### 3.3 Biomes
`T = fbm2(x*0.0025+1000, z*0.0025, 2)`, `H = fbm2(x*0.0025, z*0.0025+1000, 2)`.
`T < −0.35` → **snowy**; else `T > 0.35 && H < 0` → **desert**; else `H > 0.15` → **forest**; else **plains**. Ocean = `h < 61`.

### 3.4 Column composition
- Ocean floor `h ≤ 60`: `sand` if `h ≥ 58` else `gravel`, 3 deep, then stone; water fills air `y ≤ 62`.
- Beach `61 ≤ h ≤ 64`, biome ≠ snowy: `sand` 3 deep, then stone.
- Plains/forest: `grass_block`, `dirt` `3 + (hash2(x,z)&1)` deep, stone.
- Snowy: `snowy_grass`, dirt 3, stone.
- Desert: `sand` 3–4, `sandstone` 3, stone.
- Mountain overrides: `84 ≤ h < 92` → surface `stone`; `h ≥ 92` → `snow_block` over stone.

### 3.5 Caves (never below y=3)
- Spaghetti: carve if `|n1| < 0.07 && |n2| < 0.07`, `n1 = noise3(x*0.025, y*0.025, z*0.025)`, `n2 = noise3(x*0.025+500, y*0.025, z*0.025+500)` (diameter 3–5).
- Cheese: carve if `noise3(x*0.02, y*0.04, z*0.02) > 0.72` and `y < 50`.
- Skip carving cells `y ≤ 63` in columns with `h ≤ 64` (no drained oceans). Carving allowed up to `y = h` (cave mouths). Target ≈ 4% air in y∈[8,50].

### 3.6 Ores (replace stone only; seeded random-walk veins clamped inside the chunk; rng `mulberry32(hash(seed,cx,cz,"ore"))`)
| ore | attempts/chunk | y range | vein |
|---|---|---|---|
| coal | 18 | 8–100 | 6–10 |
| iron | 12 | 4–60 | 4–8 |
| gold | 3 | 4–30 | 3–6 |
| diamond | 1 | 2–14 | 2–5 |
| gravel pocket (opt.) | 4 | 8–70 | 10–16 |
| dirt pocket (opt.) | 6 | 8–90 | 10–16 |

### 3.7 Trees (oak)
- Trunk `H ∈ {4,5,6}` weights 40/40/20, logs `y = base..top` (`top = base+H−1`), base = h+1 on `grass_block`/`snowy_grass`, `h ≥ 63`.
- Leaves (never replace logs): `top−2`: 5×5, corners kept p0.5; `top−1`: 5×5, corners p0.5; `top`: 3×3, corners p0.5; `top+1`: plus shape (5).
- Density: forest 7 attempts/chunk (≈5 trees), plains 1 attempt p0.25, snowy 1 attempt p0.3, desert 0. Reject trunks within Chebyshev distance < 3 of an accepted trunk.
- Cross-chunk: `treesFor(cx,cz)` is a pure function (chunk hash + height function); chunk builds evaluate the 3×3 neighbourhood and write the cells that land inside.

### 3.8 Spawn
Spiral from (0,0) in 8-block steps to the first column with `h ≥ 64` and no water; player at `(x+0.5, h+1.01, z+0.5)` facing +Z.

---

## 4. Controls (`KeyboardEvent.code`)

| Action | Binding | Notes |
|---|---|---|
| Move | `KeyW/A/S/D`, also arrows | walk 4.317 m/s |
| Jump / fly up | `Space` | preventDefault |
| Sneak / fly down | `ShiftLeft` (`ShiftRight`) | 1.31 m/s, eye 1.27. Edge-fall prevention skipped in v1 |
| Sprint | **double-tap `KeyW`** (≤250 ms), sprint while W held | 5.612 m/s, FOV 70→80 over 0.15 s. Ctrl not used: `Ctrl+W` closes the tab |
| Toggle fly | **double-tap `Space`** (≤300 ms) or `KeyF` | fly 10.8 m/s (sprint 21.6), vertical 7.5; flight ends on landing |
| Break | mouse button 0 | instant, repeat 250 ms |
| Place | mouse button 2 | repeat 200 ms; `contextmenu` prevented |
| Pick block | mouse button 1 | id in hotbar → select it; else assign to selected slot; `mousedown` prevented |
| Hotbar | `Digit1–9`; wheel (`deltaY>0` next, wraps) | |
| Block picker | `KeyE` toggle; `Escape` closes | |
| Debug overlay | `F3` (preventDefault) | |
| Pause | `Escape` → pointer lock lost → pause menu | |
| Mute | `KeyM` | if audio shipped |
| Look | mouse under pointer lock, 0.002 rad/px, pitch ±89.9° | |

Game input processed **only while `document.pointerLockElement === canvas`**; `window.blur` clears held keys; wheel listener `{passive:true}`.

---

## 5. HUD / UI

### 5.1 DOM (`index.html`)
```html
<canvas id="game-canvas"></canvas>                                            <!-- z 0 -->
<div id="hud" class="layer">                                                   <!-- z 10 -->
  <div id="crosshair"></div>
  <div id="underwater-overlay" class="hidden"></div>
  <div id="block-toast" class="hidden"></div>
  <div id="save-toast" class="hidden"></div>
  <div id="hotbar"><!-- 9× --><div class="hotbar-slot selected" data-slot="0"><canvas class="slot-icon" width="32" height="32"></canvas></div></div>
  <pre id="debug-overlay" class="hidden"></pre>
</div>
<div id="block-picker" class="layer hidden">                                   <!-- z 20 -->
  <div class="picker-panel">
    <div class="picker-title">Blocks</div>
    <div id="picker-grid"><!-- <button class="picker-cell" data-block-id="1"><canvas width="32" height="32"></canvas></button> ×23 --></div>
    <div id="picker-name">&nbsp;</div>
    <div class="picker-hint">Click: put in selected slot · 1–9 while hovering: put in that slot · E / Esc: close</div>
  </div>
</div>
<div id="pause-menu" class="layer hidden">                                     <!-- z 30 -->
  <div class="menu-panel">
    <h2 class="menu-title">Game Paused</h2>
    <button id="btn-resume" class="mc-button">Back to Game</button>
    <button id="btn-save" class="mc-button">Save World</button>
    <button id="btn-quit" class="mc-button">Save and Quit to Title</button>
    <div id="pause-seed" class="menu-note">Seed: …</div>
    <div class="controls-sheet"></div>
  </div>
</div>
<div id="click-to-play" class="layer hidden"><div class="ctp-text">Click to play</div></div>  <!-- z 35 -->
<div id="loading-screen" class="layer hidden">                                 <!-- z 40 -->
  <div class="loading-title">Building terrain…</div>
  <div class="progress"><div id="loading-bar" class="progress-fill"></div></div>
  <div id="loading-text">0 / 19 chunks</div>
</div>
<div id="title-screen" class="layer">                                          <!-- z 50 -->
  <canvas id="title-logo" width="200" height="32"></canvas>
  <div id="splash-text"></div>
  <div class="title-menu">
    <div class="seed-row"><label for="seed-input">Seed</label><input id="seed-input" type="text" placeholder="random" autocomplete="off"></div>
    <button id="btn-new-world" class="mc-button">New World</button>
    <button id="btn-continue" class="mc-button" disabled>Continue</button>
  </div>
  <div id="title-controls" class="controls-sheet"></div>
  <div id="title-footer">Caelancraft v0.1 · Three.js · no assets were downloaded</div>
</div>
```

### 5.2 CSS (`src/styles.css`)
```css
html,body{margin:0;height:100%;overflow:hidden;background:#000;font-family:Consolas,"Lucida Console","Courier New",ui-monospace,monospace;user-select:none}
#game-canvas{position:fixed;inset:0;width:100%;height:100%;display:block;z-index:0}
canvas{image-rendering:pixelated}
.layer{position:fixed;inset:0} .hidden{display:none!important}
#hud{z-index:10;pointer-events:none} #hud.picker-open #hotbar{pointer-events:auto}
#crosshair{position:absolute;left:50%;top:50%;width:20px;height:20px;transform:translate(-50%,-50%);mix-blend-mode:difference;
  background:linear-gradient(#fff,#fff) center/100% 2px no-repeat,linear-gradient(#fff,#fff) center/2px 100% no-repeat}
#underwater-overlay{position:absolute;inset:0;background:rgba(20,60,160,.45)}
#hotbar{position:absolute;bottom:8px;left:50%;transform:translateX(-50%);display:flex;gap:2px;padding:3px;background:rgba(20,20,20,.7);border:2px solid #a0a0a0;box-shadow:0 0 0 2px #000}
.hotbar-slot{width:40px;height:40px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;background:rgba(139,139,139,.35);border:1px solid #2b2b2b}
.hotbar-slot.selected{border:2px solid #fff;box-shadow:inset 0 0 0 1px #000}
.slot-icon{width:32px;height:32px}
#block-toast{position:absolute;bottom:64px;left:50%;transform:translateX(-50%);color:#fff;font:bold 18px monospace;text-shadow:2px 2px 0 #3f3f3f;opacity:1;transition:opacity .3s}
#block-toast.fade{opacity:0}
#save-toast{position:absolute;top:12px;right:12px;color:#55ff55;font:bold 14px monospace;text-shadow:1px 1px 0 #000} #save-toast.error{color:#ff5555}
#debug-overlay{position:absolute;top:4px;left:4px;margin:0;font:14px/18px monospace;color:#e0e0e0;text-shadow:1px 1px 0 #000;background:rgba(0,0,0,.35);padding:4px 6px;white-space:pre}
#block-picker{z-index:20;pointer-events:none;display:flex;align-items:flex-start;justify-content:center;padding-top:8vh;background:rgba(0,0,0,.45)}
.picker-panel{pointer-events:auto;background:#c6c6c6;border:4px solid;border-color:#fff #555 #555 #fff;box-shadow:0 0 0 2px #000;padding:12px}
.picker-title,#picker-name{color:#404040;font:bold 16px monospace}
#picker-grid{display:grid;grid-template-columns:repeat(8,72px);gap:4px;margin:8px 0}
.picker-cell{width:72px;height:72px;padding:0;background:#8b8b8b;border:2px solid;border-color:#373737 #fff #fff #373737;cursor:pointer;display:flex;align-items:center;justify-content:center}
.picker-cell:hover{outline:2px solid #fff;outline-offset:-2px} .picker-cell canvas{width:64px;height:64px}
.picker-hint{color:#5a5a5a;font:12px monospace}
#pause-menu{z-index:30;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center}
.menu-panel{display:flex;flex-direction:column;align-items:center;gap:8px}
.menu-title{color:#fff;font:bold 28px monospace;text-shadow:3px 3px 0 #3f3f3f;margin:0 0 12px}
.mc-button{min-width:320px;padding:10px 16px;background:#6f6f6f;color:#e0e0e0;font:bold 18px monospace;text-shadow:2px 2px 0 #202020;border:2px solid;border-color:#aaa #555 #555 #aaa;box-shadow:0 0 0 2px #000;cursor:pointer}
.mc-button:hover:not(:disabled){background:#7f8fbf;color:#ffffa0} .mc-button:disabled{background:#4a4a4a;color:#a0a0a0;cursor:default}
.menu-note{color:#c0c0c0;font:13px monospace}
#click-to-play{z-index:35;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);cursor:pointer}
.ctp-text{color:#fff;font:bold 32px monospace;text-shadow:3px 3px 0 #3f3f3f}
#loading-screen,#title-screen{background-size:64px 64px} /* background-image = dirt data URL, set at runtime */
#loading-screen::before,#title-screen::before{content:"";position:absolute;inset:0;background:rgba(0,0,0,.55);z-index:-1}
#loading-screen{z-index:40;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px}
.loading-title{color:#fff;font:bold 20px monospace;text-shadow:2px 2px 0 #3f3f3f}
.progress{width:400px;height:16px;background:#000;border:2px solid #7f7f7f} .progress-fill{height:100%;width:0%;background:#7fbf3f;transition:width .1s linear}
#loading-text{color:#c0c0c0;font:14px monospace}
#title-screen{z-index:50;display:flex;flex-direction:column;align-items:center;padding-top:10vh}
#title-logo{width:min(800px,90vw);height:auto}
#splash-text{position:absolute;top:calc(10vh + 92px);left:calc(50% + 150px);color:#ff0;font:bold 20px monospace;text-shadow:2px 2px 0 #3f3f00;transform:rotate(-20deg);transform-origin:center;animation:splash-pulse .5s ease-in-out infinite alternate}
@keyframes splash-pulse{from{transform:rotate(-20deg) scale(1)}to{transform:rotate(-20deg) scale(1.08)}}
.title-menu{margin-top:48px;display:flex;flex-direction:column;align-items:center;gap:8px}
.seed-row label{color:#fff;font:bold 16px monospace;margin-right:8px;text-shadow:1px 1px 0 #000}
#seed-input{width:220px;padding:6px 8px;background:#000;color:#fff;border:2px solid #a0a0a0;font:16px monospace}
.controls-sheet{margin-top:32px;display:grid;grid-template-columns:auto auto;gap:4px 16px;color:#e0e0e0;font:13px monospace;text-shadow:1px 1px 0 #000}
kbd{display:inline-block;min-width:18px;padding:1px 6px;background:#2b2b2b;border:1px solid #777;border-bottom-width:3px;color:#fff;font:bold 12px monospace;text-align:center}
#title-footer{position:absolute;bottom:8px;left:8px;color:#c0c0c0;font:12px monospace;text-shadow:1px 1px 0 #000}
```
Z-order: canvas 0 → hud 10 → picker 20 → pause 30 → click-to-play 35 → loading 40 → title 50.

### 5.3 Title logo
On the 200×32 `#title-logo` canvas: `font="bold 22px monospace"`, `textBaseline="middle"`, `textAlign="center"`; shadow `fillStyle="#1a1a1a"; fillText("Caelancraft",102,18)`; then `fillStyle=ctx.createPattern(stoneTileCanvas,"repeat"); fillText(…,100,16)`; then `lineWidth=1; strokeStyle="#000"; strokeText(…,100,16)`. CSS scales ×4 pixelated → chunky stone logo with no assets.

### 5.4 Splash strings
"Caelan approved!", "Hand-crafted by Caelan!", "Caelan was here", "Caelancraft: now in 3D!", "Now with 100% more cubes!", "Zero textures downloaded!", "Procedurally generated!", "Don't dig straight down!", "Diamonds are down there somewhere", "Infinite* (*until your RAM runs out)", "Powered by Three.js!", "Punch trees!", "Also try sleeping!", "Built in a browser!", "Double-tap space to fly!", "No creepers were harmed", "Shift to sneak, E for blocks", "It's a feature!"

### 5.5 Behaviours
- Hotbar: `setHotbar(ids)` redraws icons; `setSelected(i)`. Empty slot blank.
- Block toast: display name for 1.5 s, then `.fade` 0.3 s, then `.hidden`; timer restarts on change.
- Debug overlay lines (updated each frame when visible):
  ```
  Caelancraft v0.1  (F3 to hide)
  FPS: 60  frame 16.7 ms
  XYZ: 12.345 / 65.000 / -7.891
  Block: 12 65 -8   Chunk: 0 -1  (local 12 8)
  Facing: south (+Z)  yaw 12.3  pitch -5.0
  Biome: forest   Seed: 123456789
  Chunks: loaded 121  meshed 119  queue 0
  Target: oak_log (14, 66, -3) face +Y
  Time: 08:32  day 1  (t=0.354)
  Mode: fly | sprint | sneak | swimming
  ```
  Facing from forward `f`: `|f.x|>|f.z| ? (f.x>0?"east (+X)":"west (-X)") : (f.z>0?"south (+Z)":"north (-Z)")`. FPS = 1 s rolling average.
- Underwater overlay visible when the eye block is water.
- Block highlight (engine): `LineSegments(EdgesGeometry(BoxGeometry(1.002,1.002,1.002)), LineBasicMaterial({color:0x000000, transparent:true, opacity:0.4}))` at block centre, only when a targetable block is within 5.0.
- Picker: open → `exitPointerLock()`, `#hud.picker-open`, state `picker`. Click cell → assign to selected slot, toast, close, re-lock. Digit while hovering → assign to that slot, stay open. Click hotbar slot → select. `#picker-name` shows hovered name.
- Pause: `pointerlockchange` with no lock and state `playing` → `paused` (simulation and clock freeze; frames keep rendering). Resume re-requests lock; Save shows `#save-toast` "World saved" 1.5 s; Quit saves and returns to title.
- Flow: `title → loading → clickToPlay → playing ⇄ paused`, `playing ⇄ picker`. New World with an existing save → `confirm("This will delete your saved world. Continue?")`. Seed: numeric → int, text → `fnv1a`, empty → `Math.floor(Math.random()*2**31)`. Loading shows `done / total` for the initial hex disc of 19 chunks (`hexDiscCount(2)`), then `#click-to-play` (fresh gesture needed for pointer lock).

---

## 6. Day/night

- Day = **720 s**. `t∈[0,1)`: 0.00 = 00:00, 0.25 = 06:00, 0.50 = 12:00, 0.75 = 18:00. Start `t=0.30` (07:12). Clock `HH:MM` from `t*24`; day counter increments at wrap.
- `φ = (t−0.25)·2π`; `sunDir = normalize(cos φ, sin φ, 0.25)`; `moonDir = −sunDir`. DirectionalLight uses sunDir for `0.25 ≤ t < 0.75`, else moonDir.
- Keyframes (linear RGB lerp; intensities for three ≥ r155 physical units with `MeshLambertMaterial`; `daylight` = scalar for baked-light engines; `stars` = star opacity):

| t | clock | zenith | horizon | fog | sun colour | sun | amb | daylight | stars |
|---|---|---|---|---|---|---|---|---|---|
| 0.00 | 00:00 | `#070B1A` | `#101833` | `#0C1228` | `#8C9AC8` | 0.35 | 0.55 | 0.22 | 1.0 |
| 0.20 | 04:48 | `#0B1430` | `#2C2F55` | `#1E2544` | `#A090B0` | 0.45 | 0.65 | 0.30 | 1.0 |
| 0.25 | 06:00 | `#23457F` | `#F0A25A` | `#D6905E` | `#FFB878` | 1.10 | 0.90 | 0.55 | 0.3 |
| 0.30 | 07:12 | `#4F8FD6` | `#B9D6F2` | `#A9C7E8` | `#FFE6C2` | 1.80 | 1.30 | 0.90 | 0.0 |
| 0.50 | 12:00 | `#6DA7FF` | `#BFDCFF` | `#B6D3F7` | `#FFF8EA` | 2.00 | 1.40 | 1.00 | 0.0 |
| 0.70 | 16:48 | `#4F8FD6` | `#C6D6EC` | `#B2C6E0` | `#FFE0B8` | 1.80 | 1.30 | 0.90 | 0.0 |
| 0.75 | 18:00 | `#22336E` | `#EF8546` | `#D27447` | `#FFA060` | 1.10 | 0.90 | 0.55 | 0.3 |
| 0.80 | 19:12 | `#0C1436` | `#302E58` | `#202646` | `#A090B0` | 0.45 | 0.65 | 0.30 | 1.0 |
| 1.00 | = 0.00 row |

- Sky dome (MVP): `SphereGeometry(500,16,8)`, `BackSide`, `depthWrite:false`, `fog:false`, `renderOrder −3`, follows camera. Shader:
  ```glsl
  // vertex
  varying vec3 vDir; void main(){ vec4 wp=modelMatrix*vec4(position,1.0); vDir=normalize(wp.xyz-cameraPosition); gl_Position=projectionMatrix*viewMatrix*wp; }
  // fragment
  uniform vec3 uZenith,uHorizon; varying vec3 vDir;
  void main(){ float h=clamp(vDir.y,0.0,1.0); gl_FragColor=vec4(mix(uZenith,uHorizon,pow(1.0-h,3.0)),1.0); }
  ```
- Fog `THREE.Fog(fogColor, far*0.55, far)`, `far = renderDistanceChunks*16`.
- Sun/moon sprites (Nice-to-have): `Sprite`, `depthTest:false, depthWrite:false, fog:false`, scale 60, at `camera + dir*400`, `renderOrder −1`. Stars: 600 `Points` on radius 490, `size 2, sizeAttenuation:false, #FFFFFF`, opacity = `stars(t)`, `rotation.z = φ`, `renderOrder −2`.

---

## 7. Water
- Static only; player-placed water = source block, no flow. Removing a block placed in water leaves an air pocket (accepted).
- Tile 7 α0.70, own per-chunk mesh, transparent pass, `depthWrite:false`, front faces. Top face at `y+0.875` when the block above is not water; side faces of such a block are 0.875 tall. Water–water faces culled.
- Raycast ignores water; placement into a water cell replaces it.
- Swimming: horizontal speed ×0.5; sink ≤ 3 m/s; `Space` rises 3.5 m/s; at the surface Space bobs the eye above; against a 1-block shore with Space held the player climbs out (jump impulse `SWIM_EXIT_JUMP` = 8.7 m/s while swimming into a wall with Space held). Flying allowed in water.
- Underwater (eye in water): overlay `rgba(20,60,160,0.45)`, fog `#204A8C` near 1 far 22, light ×0.7.

---

## 8. Save / load
- `caelancraft:v1:meta` → `{version:1, seed, savedAt, player:{x,y,z,yaw,pitch,flying}, time, day, hotbar:[9], selectedSlot}`
- `caelancraft:v1:chunk:<cx>,<cz>` → flat `[localIndex, blockId, …]`, `localIndex = (y*16+z)*16+x` (0–32767); last write wins; edits back to generated values still stored.
- Enumerate chunks by scanning `Object.keys(localStorage)` for the prefix.
- Autosave every **30 s** (dirty chunks + meta) and on `beforeunload`, `pagehide`, `visibilitychange→hidden`, pause open, Save/Quit buttons. Synchronous.
- Load: generate → apply deltas → mesh. `version !== 1` → no save. `QuotaExceededError` → `#save-toast.error` "Save failed: storage full".
- Size: ~8 chars/edit → 1k edits ≈ 8 KB; typical 20–50 KB.
- Title: `#btn-continue` enabled iff `hasSave()`; New World clears `caelancraft:v1:*` after confirm.

---

## 9. Break / place feel
- Instant break; bedrock unbreakable; water untargetable.
- Place at `hit + faceNormal` if the cell is air/water and the cube does not intersect the player AABB (`[x−0.3,x+0.3]×[y,y+1.8]×[z−0.3,z+0.3]`), else no-op.
- Particles (Nice-to-have): 12–16 cubes size 0.1, colour `averageColor(side tile)`, velocity ±3 m/s h / 2–5 m/s up, gravity 20, life 0.6 s, `InstancedMesh` pool 256.
- Audio (Nice-to-have): WebAudio synth, context created on first gesture, `M` mutes. Break = 90 ms white-noise burst through lowpass (stone 1400 Hz, dirt/sand/snow/gravel 900, wood 1100, leaves/cloth 700, glass 3000 + 40 ms 2400 Hz ping), exponential decay. Place = sine 180→90 Hz sweep 70 ms + 15 ms noise click. UI/hotbar click = 1200 Hz sine 20 ms gain 0.15. Pitch ±10% random.

---

## 10. Prioritised features

**MVP**: block registry + atlas + icons; worldgen per §3; engine chunks/mesh/physics/raycast; movement incl. double-W sprint and fly; break/place/pick + highlight; hotbar + toast + picker; day/night sky dome, fog, light keyframes; water render + swim + overlay; title/loading/click-to-play/pause; save/load + autosave; debug overlay; Vitest for registry, tile determinism/alpha rules, save round-trip, worldgen determinism/bounds.

**Nice-to-have**: sun/moon + stars; break particles; WebAudio SFX; sneak edge prevention; clouds.

**Stretch**: water flow; block light + glowstone/torches; survival hold-to-break; padded atlas/mipmaps; held-block view model; rivers/lakes, multiple save slots.
